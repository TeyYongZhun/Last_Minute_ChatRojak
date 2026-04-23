import { createEvent } from "./services/googleCalendar.js";

async function test() {
  try {
    const link = await createEvent(
      "Test Assignment",
      "2026-04-25T23:59:00"
    );

    console.log("Event:", link);
  } catch (err) {
    console.error("Error:", err.message);
  }
}

test();