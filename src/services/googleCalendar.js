/**
 * @deprecated dev-only stub used exclusively by src/testCalendar.js.
 * Production code must use src/integrations/googleCalendar.js, which enforces
 * strict `summary = task.task` and `start = task.deadline_iso` rules.
 * Do not import from this module in request handlers or sync pipelines.
 */
import fs from "fs";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TOKEN_PATH = "token.json";

export async function createEvent(summary, datetimeISO) {
  const credentials = JSON.parse(fs.readFileSync("credentials.json"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
  oAuth2Client.setCredentials(token);

  const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

  const event = {
    summary,
    start: {
      dateTime: datetimeISO,
      timeZone: "Asia/Kuala_Lumpur",
    },
    end: {
      dateTime: datetimeISO,
      timeZone: "Asia/Kuala_Lumpur",
    },
  };

  const res = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
  });

  return res.data.htmlLink;
}