import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = path.join(__dirname, '../../token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../../credentials.json');

function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH);
  return JSON.parse(content);
}

function authorize() {
  const credentials = loadCredentials();
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH);
    oAuth2Client.setCredentials(JSON.parse(token));
    return oAuth2Client;
  }
  throw new Error('No token.json found. Run auth setup first.');
}

export async function createEvent(summary, datetimeISO) {
  try {
    const auth = authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary,
      start: {
        dateTime: datetimeISO,
        timeZone: 'Asia/Kuala_Lumpur',
      },
      end: {
        dateTime: datetimeISO,
        timeZone: 'Asia/Kuala_Lumpur',
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    return response.data.htmlLink;
  } catch (err) {
    console.error('Calendar error:', err.message);
    return null;
  }
}

export default { createEvent, SCOPES };