// Settings a production server must have before it holds patient data. The server refuses to start in
// production (NODE_ENV=production) while any of these are missing, so an unsafe deploy fails loudly
// instead of quietly storing PHI unprotected.
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// A copy that isn't holding real patients' data: APP_ENV says demo or staging, or the demo practice is loaded
// and nothing claims to be production.
export const isDemoOrStaging = (env = process.env) => ['demo', 'staging'].includes(String(env.APP_ENV || '').toLowerCase())
  || (env.DEMO_SEED === 'on' && env.APP_ENV !== 'production');

export function productionProblems(env = process.env) {
  const problems = [];
  const secret = env.JWT_SECRET || '';
  if (secret.length < 32) problems.push('JWT_SECRET must be set to a random value of at least 32 characters (e.g. `openssl rand -hex 32`)');
  if ((env.DOCUMENT_ENCRYPTION_KEY || '').length < 32 && env.ALLOW_UNENCRYPTED_FILES !== '1') {
    problems.push('DOCUMENT_ENCRYPTION_KEY must be set to a random value of at least 32 characters so x-rays and documents are encrypted at rest');
  }
  const appUrl = (env.APP_URL || env.RENDER_EXTERNAL_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')).replace(/\/$/, '');
  if (!appUrl) problems.push('APP_URL must be set to the https:// address patients and staff use');
  else if (!appUrl.startsWith('https://') && !LOCAL.test(appUrl)) problems.push(`APP_URL must start with https:// (it is ${appUrl}); links in texts and emails, and secure cookies, depend on it`);
  // A server that says it is the real thing (APP_ENV=production) must not fake payers, payments or pharmacies:
  // sandbox drivers there would record pretend claims and card payments against real patients.
  if (env.APP_ENV === 'production') {
    const fake = ['EDI_MODE', 'PAYMENTS', 'ERX', 'SMS_DRIVER', 'MAIL_DRIVER', 'PLAID', 'QBO', 'XRAY_AI', 'GOOGLE_BUSINESS', 'TRANSCRIBE', 'CLEARINGHOUSE']
      .filter((k) => ['sandbox', 'log'].includes(String(env[k] || '').toLowerCase()));
    if (fake.length) problems.push(`APP_ENV=production can't use sandbox or log-only integrations (${fake.join(', ')}); use APP_ENV=staging or demo for those`);
  }
  // Sign-in and public-page limits are counted in Redis when there's more than one server; on a host that
  // runs many copies (serverless), counts kept in each copy's memory can be multiplied by spreading requests.
  // Required where real patient data lives. A demo or staging copy (APP_ENV=demo/staging, or the demo practice
  // loaded with DEMO_SEED=on and no APP_ENV=production) starts without it; api/index.js logs a warning instead.
  if ((env.VERCEL || env.SERVERLESS === '1') && !env.REDIS_URL && !isDemoOrStaging(env)) problems.push('REDIS_URL must be set on serverless hosting so sign-in and public-page limits are shared by every copy of the server');
  if (env.BACKUP_DIR && (env.BACKUP_ENCRYPTION_KEY || '').length < 32) problems.push('BACKUP_ENCRYPTION_KEY (at least 32 characters) must be set when BACKUP_DIR is, so backups are encrypted');
  return problems;
}
