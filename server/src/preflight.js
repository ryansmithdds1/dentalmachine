// Settings a production server must have before it holds patient data. The server refuses to start in
// production (NODE_ENV=production) while any of these are missing, so an unsafe deploy fails loudly
// instead of quietly storing PHI unprotected.
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

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
  if (env.BACKUP_DIR && (env.BACKUP_ENCRYPTION_KEY || '').length < 32) problems.push('BACKUP_ENCRYPTION_KEY (at least 32 characters) must be set when BACKUP_DIR is, so backups are encrypted');
  return problems;
}
