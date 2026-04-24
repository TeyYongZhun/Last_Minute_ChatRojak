import { createEvent } from './services/googleCalendar.js';

(async () => {
  const link = await createEvent(
    'Submit Assignment',
    '2026-04-25T23:59:00'
  );

  console.log('Event:', link);
})();