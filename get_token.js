const https = require('https');
const fs = require('fs');
require('dotenv').config();

const TOKEN_FILE = 'twitch_token.json';
const REDIRECT_URI = 'http://localhost:3000/callback';

const saveToken = (tokenData) => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
};

const getTokenFromCode = (code) => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    });

    const options = {
      hostname: 'id.twitch.tv',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          const tokenData = JSON.parse(responseData);
          tokenData.expires_at = Date.now() + (tokenData.expires_in * 1000);
          saveToken(tokenData);
          resolve(tokenData);
        } else {
          reject(new Error(`Token request failed: ${responseData}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
};

// Get the authorization code from command line argument
const code = process.argv[2];
if (!code) {
  console.log('Please provide the authorization code as a command line argument.');
  console.log('To get the code:');
  console.log(`1. Visit: https://id.twitch.tv/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=chat:read+chat:edit+whispers:read+whispers:edit`);
  console.log('2. Authorize the application');
  console.log('3. Copy the code from the URL after authorization');
  console.log('4. Run this script with the code: node get_token.js YOUR_CODE');
  process.exit(1);
}

getTokenFromCode(code)
  .then(tokenData => {
    console.log('Token saved successfully!');
    console.log('You can now run the main bot.');
  })
  .catch(error => {
    console.error('Error getting token:', error);
  }); 