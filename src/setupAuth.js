<<<<<<< HEAD
import fs from 'fs';
import readline from 'readline';
import { google } from 'googleapis';

const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
=======
import fs from "fs";
import readline from "readline";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = "token.json";

const credentials = JSON.parse(fs.readFileSync("credentials.json"));
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c
const { client_secret, client_id, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

const authUrl = oAuth2Client.generateAuthUrl({
<<<<<<< HEAD
  access_type: 'offline',
  scope: SCOPES,
});

console.log('Authorize this app by visiting this URL:\n', authUrl);
=======
  access_type: "offline",
  scope: SCOPES,
});

console.log("Authorize this app by visiting this URL:\n", authUrl);
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

<<<<<<< HEAD
rl.question('Enter the code from that page here: ', (code) => {
  rl.close();
  oAuth2Client.getToken(code, (err, token) => {
    if (err) return console.error('Error retrieving token', err);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    console.log('Token stored to', TOKEN_PATH);
    return undefined;
  });
=======
rl.question("Enter the code from that page here: ", async (code) => {
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
    console.log("Token stored to", TOKEN_PATH);
  } catch (err) {
    console.error("Error retrieving token", err);
  }
  rl.close();
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c
});