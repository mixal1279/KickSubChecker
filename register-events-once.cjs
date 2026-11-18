
require('dotenv').config();

const base = process.env.WORKER_URL?.trim().replace(/\/+$/, '');
const secret = process.env.ADMIN_API_SECRET;

if (!base || !secret) {
  console.error('Brak WORKER_URL lub ADMIN_API_SECRET w .env');
  process.exit(1);
}

(async () => {
  const response = await fetch(`${base}/register-events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`
    }
  });

  const body = await response.text();

  console.log(`Rejestracja Kick: HTTP ${response.status}`);

  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }

  if (!response.ok) process.exitCode = 1;
})().catch(error => {
  console.error('Błąd połączenia:', error.message);
  process.exitCode = 1;
});