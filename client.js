const tmi = require("tmi.js");
const { Client, ActivityType } = require("discord.js");
const fs = require("fs");
const https = require("https");
require("dotenv").config();

let tmiClient = null;

const TOKEN_FILE = "twitch_token.json";
const TARGET_CHANNEL = "itzdatrat";
const DISCORD_USER_ID_TO_OBSERVE = "595905911814357013";

const saveToken = (tokenData) => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
};

const loadToken = () => {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    }
  } catch (error) {
    console.error("Error loading token:", error);
  }
  return null;
};

const createTmiClient = (oauthToken) => {
  return new tmi.Client({
    options: { debug: true },
    connection: {
      secure: true,
      reconnect: false,
    },
    identity: {
      username: "musica_da_crems",
      password: oauthToken,
    },
    channels: [TARGET_CHANNEL],
  });
};

let tokenRefreshTimeout = null;

const clearTokenRefreshTimer = () => {
  if (tokenRefreshTimeout) {
    clearTimeout(tokenRefreshTimeout);
    tokenRefreshTimeout = null;
  }
};

const scheduleTokenRefresh = (expiresAtMs) => {
  clearTokenRefreshTimer();
  if (!expiresAtMs) return;
  const refreshLeadTimeMs = 2 * 60 * 1000; // refresh 2 minutes before expiry
  const delayMs = Math.max(
    30 * 1000,
    expiresAtMs - Date.now() - refreshLeadTimeMs
  );
  tokenRefreshTimeout = setTimeout(async () => {
    try {
      console.log("Proactively refreshing Twitch OAuth token before expiry...");
      const newToken = await refreshOAuthToken();
      await rebuildTmiClient(newToken);
    } catch (err) {
      console.error("Proactive token refresh failed:", err);
      tokenRefreshTimeout = setTimeout(async () => {
        try {
          const newToken = await refreshOAuthToken();
          await rebuildTmiClient(newToken);
        } catch (e2) {
          console.error("Second proactive refresh attempt failed:", e2);
        }
      }, 60 * 1000);
    }
  }, delayMs);
};

const teardownTmiClient = async () => {
  try {
    if (tmiClient) {
      tmiClient.removeAllListeners && tmiClient.removeAllListeners();
      try {
        await tmiClient.disconnect();
      } catch (_) {}
    }
  } finally {
    clearTokenRefreshTimer();
    tmiClient = null;
    isInitialized = false;
  }
};

const onTmiMessage = (channel, tags, message, self) => {
  if (self) return;

  const command = message.toLowerCase();

  if (adminCommands.includes(command)) {
    if (!hasPermission(tags)) return;

    if (command === "!mstart") {
      if (isBotActive) {
        tmiClient && tmiClient.say(channel, "Já estou de olho!");
      } else {
        isBotActive = true;
        if (latestSongInfo) {
          setDiscordStatus(true);
        }
        tmiClient && tmiClient.say(channel, "Tá bom minha vida, tô de olho...");
      }
    } else if (command === "!mstop") {
      if (!isBotActive) {
        tmiClient && tmiClient.say(channel, "Já estou em segredo!");
      } else {
        isBotActive = false;
        setDiscordStatus(false);
        tmiClient &&
          tmiClient.say(channel, "Tá bom minha vida, não vou mais vazar nada!");
      }
    }
    return;
  }

  if (isBotActive && musicCommands.includes(command)) {
    if (!isInitialized || !tmiClient) {
      console.log("TMI client not ready yet, skipping message");
      return;
    }

    if (latestSongInfo) {
      const timeRemaining = getTimeRemaining(latestSongInfo);

      tmiClient.say(
        channel,
        `-> ${latestSongInfo.details} por ${latestSongInfo.state} - ${timeRemaining} restantes`
      );
    } else {
      tmiClient.say(
        channel,
        `Não tenho informações da musica da CREMOSA ainda...`
      );
    }
  }
};

const onTmiDisconnected = (reason) => {
  console.log(`TMI client disconnected: ${reason}`);
  handleReconnection("disconnected");
};

const onTmiError = (error) => {
  console.error("TMI client error:", error);
  handleReconnection("error");
};

const attachTmiEventListeners = (client) => {
  client.removeAllListeners && client.removeAllListeners();
  client.on("message", onTmiMessage);
  client.on("disconnected", onTmiDisconnected);
  client.on("error", onTmiError);
};

const refreshOAuthToken = async () => {
  const tokenData = loadToken();
  if (!tokenData || !tokenData.refresh_token) {
    throw new Error("No refresh token available. Please authenticate first.");
  }

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: tokenData.refresh_token,
    });

    const options = {
      hostname: "id.twitch.tv",
      path: "/oauth2/token",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
      },
    };

    const req = https.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          const newTokenData = JSON.parse(responseData);
          newTokenData.expires_at = Date.now() + newTokenData.expires_in * 1000;
          saveToken(newTokenData);
          resolve(`oauth:${newTokenData.access_token}`);
        } else {
          reject(new Error(`Token refresh failed: ${responseData}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
};

const initializeTmiClient = async () => {
  try {
    const tokenData = loadToken();
    if (!tokenData) {
      throw new Error("No token data found. Please authenticate first.");
    }

    // Check if token needs refresh
    let oauthToken;
    let effectiveTokenData = tokenData;
    if (Date.now() >= tokenData.expires_at) {
      console.log("Token expired, refreshing...");
      oauthToken = await refreshOAuthToken();
      effectiveTokenData = loadToken() || tokenData;
    } else {
      oauthToken = `oauth:${tokenData.access_token}`;
    }

    await teardownTmiClient();
    tmiClient = createTmiClient(oauthToken);
    attachTmiEventListeners(tmiClient);
    await tmiClient.connect();
    isInitialized = true;
    scheduleTokenRefresh(effectiveTokenData.expires_at);
  } catch (error) {
    if (
      error.message?.includes?.("Login authentication failed") ||
      error.message?.includes?.("No token data found")
    ) {
      console.log("Login failed, attempting to refresh OAuth token...");
      try {
        const newToken = await refreshOAuthToken();
        await teardownTmiClient();
        tmiClient = createTmiClient(newToken);
        attachTmiEventListeners(tmiClient);
        await tmiClient.connect();
        isInitialized = true;
        const refreshed = loadToken();
        scheduleTokenRefresh(refreshed?.expires_at);
      } catch (refreshError) {
        console.error("Failed to refresh token:", refreshError);
        throw new Error(
          "Authentication failed and token refresh unsuccessful. Please re-authenticate."
        );
      }
    } else {
      throw error;
    }
  }
};

let isInitialized = false;
let isReconnecting = false;
let lastReconnectAttempt = 0;
const RECONNECT_COOLDOWN = 5000;

const rebuildTmiClient = async (oauthToken) => {
  await teardownTmiClient();
  tmiClient = createTmiClient(oauthToken);
  attachTmiEventListeners(tmiClient);
  await tmiClient.connect();
  isInitialized = true;
  const newData = loadToken();
  scheduleTokenRefresh(newData?.expires_at);
};

const initializeAndConnect = async () => {
  try {
    await initializeTmiClient();
    isInitialized = true;
    isReconnecting = false;
    console.log("TMI client successfully initialized and connected");
  } catch (error) {
    console.error("Failed to initialize TMI client:", error);
    isReconnecting = false;
    setTimeout(initializeAndConnect, 30000);
  }
};

const musicCommands = [
  "!musica",
  "!song",
  "!nowplaying",
  "!np",
  "!current",
  "!playing",
  "!music",
  "!m",
];

const adminCommands = ["!mstart", "!mstop"];
let isBotActive = true;

const hasPermission = (tags) => {
  return (
    tags.username.toLowerCase() === TARGET_CHANNEL || // Host
    tags.mod || // Moderator
    tags.badges?.broadcaster === "1" // Broadcaster
  );
};

const setDiscordStatus = (active) => {
  if (active) {
    if (latestSongInfo) {
      discordClient.user.setStatus("online");
      discordClient.user.setActivity(
        `${latestSongInfo.details} por ${latestSongInfo.state}`,
        { type: ActivityType.Listening }
      );
    }
  } else {
    discordClient.user.setStatus("idle");
    discordClient.user.setActivity("é segredo", {
      type: ActivityType.Listening,
    });
  }
};

// DISCORD //

const discordClient = new Client({
  intents: ["Guilds", "GuildPresences"],
});

discordClient.on("ready", () => {
  console.log(`Bot do ${discordClient.user.tag} está online!`);
  console.log(`Pronto para ver qual musica a CREMOSA está ouvindo!`);
});

discordClient.login(process.env.DISCORD_TOKEN).catch(console.error);

const saveLatestSongInfo = (info) => {
  try {
    fs.writeFileSync("latestSongInfo.json", JSON.stringify(info, null, 2));
  } catch (error) {
    console.error("Error saving latestSongInfo:", error);
  }
};

const loadLatestSongInfo = () => {
  try {
    if (fs.existsSync("latestSongInfo.json")) {
      const data = fs.readFileSync("latestSongInfo.json", "utf8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("Error loading latestSongInfo:", error);
  }
  return null;
};

let latestSongInfo = loadLatestSongInfo();
console.log(
  `Ultima musica recuperada do .json: ${latestSongInfo?.details} por ${latestSongInfo?.state}`
);
let previousSongInfo = null;
let songStartTime = null;
let fetchTimestamp = null;
let activityTimeout = null;

const clearActivity = () => {
  discordClient.user.setActivity(null);
  latestSongInfo = null;
  previousSongInfo = null;
  songStartTime = null;
  saveLatestSongInfo(null);
  console.log("Cleared activity due to no Spotify updates for 10 minutes");
};

const resetActivityTimeout = () => {
  if (activityTimeout) {
    clearTimeout(activityTimeout);
  }
  activityTimeout = setTimeout(clearActivity, 10 * 60 * 1000); // 10m
};

if (latestSongInfo) {
  resetActivityTimeout();
}

discordClient.on("presenceUpdate", (oldPresence, newPresence) => {
  if (
    newPresence.userId === DISCORD_USER_ID_TO_OBSERVE &&
    newPresence.activities &&
    newPresence.activities.some((activity) => activity.type === 2)
  ) {
    const spotifyActivity = newPresence.activities.find(
      (activity) => activity.name === "Spotify"
    );
    console.log(spotifyActivity);
    fetchTimestamp = Date.now();
    if (spotifyActivity) {
      const user = discordClient.users.cache.get(newPresence.userId);
      const currentSongInfo = spotifyActivity;
      if (
        !previousSongInfo ||
        currentSongInfo.details !== previousSongInfo.details ||
        currentSongInfo.state !== previousSongInfo.state
      ) {
        latestSongInfo = currentSongInfo;
        songStartTime = Date.now();
        saveLatestSongInfo(latestSongInfo);
        resetActivityTimeout();
        if (latestSongInfo) {
          if (isBotActive && tmiClient) {
            tmiClient.say(
              TARGET_CHANNEL,
              `Tocando agora -> ${latestSongInfo.details} por ${latestSongInfo.state}`
            );
            setDiscordStatus(true);
          }
          previousSongInfo = latestSongInfo;
        }
      } else {
        console.log("Song has not changed, skipping update.");
        resetActivityTimeout();
      }
    } else {
      console.log("No Spotify activity detected.");
    }
  } else {
    console.log("No listening activity detected or user ID mismatch.");
  }
});

// DISCORD //

const getTimeRemaining = (latestSongInfo) => {
  if (!latestSongInfo || !songStartTime) {
    return "00:00";
  }

  const now = Date.now();
  const elapsedTime = Math.floor((now - songStartTime) / 1000);
  const totalDuration = Math.floor(
    (new Date(latestSongInfo.timestamps.end).getTime() -
      new Date(latestSongInfo.timestamps.start).getTime()) /
      1000
  );
  const remainingTime = Math.max(0, totalDuration - elapsedTime);

  const minutes = String(Math.floor(remainingTime / 60)).padStart(2, "0");
  const seconds = String(remainingTime % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
};

// TMI //

const handleReconnection = (source) => {
  const now = Date.now();

  if (isReconnecting || now - lastReconnectAttempt < RECONNECT_COOLDOWN) {
    console.log(
      `Skipping reconnection attempt from ${source} - ${
        isReconnecting ? "already reconnecting" : "within cooldown period"
      }`
    );
    return;
  }

  isInitialized = false;
  isReconnecting = true;
  lastReconnectAttempt = now;

  console.log(`Initiating reconnection from ${source}`);
  setTimeout(() => {
    teardownTmiClient()
      .catch(() => {})
      .finally(() => initializeAndConnect());
  }, RECONNECT_COOLDOWN);
};

// TMI //

initializeAndConnect();
