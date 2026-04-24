<<<<<<< HEAD
import { createEvent } from './services/googleCalendar.js';

(async () => {
  const link = await createEvent(
    'Submit Assignment',
    '2026-04-25T23:59:00'
  );

  console.log('Event:', link);
})();
=======
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
>>>>>>> 7f72f9074e2ba08e9e079365fde80d24705a9b3c
