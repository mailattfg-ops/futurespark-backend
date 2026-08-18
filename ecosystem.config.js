/**
 * pm2 process definitions for the backend.
 *
 * `npm start` runs all seven services under `concurrently` in the foreground.
 * That is fine for local development and wrong for a server:
 *
 *   - it dies when the SSH session ends
 *   - `npm restart` never stopped anything, because there was no stop script,
 *     so a "restart" only added a second copy and every port collided
 *   - the logger writes to the console only, so with nothing capturing stdout
 *     the logs simply did not exist when they were needed
 *
 * pm2 fixes all three: services survive logout, restart cleanly one at a time,
 * and every line is written to a file under logs/.
 *
 *   pm2 start ecosystem.config.js     # first time
 *   pm2 restart learning-service      # one service, properly
 *   pm2 logs learning-service         # tail it
 *   pm2 save && pm2 startup           # survive a reboot
 */
const service = (name, dir, port) => ({
  name,
  cwd: `${__dirname}/apps/${dir}`,
  script: 'dist/server.js',
  // One instance each: these hold in-memory state — the transcription
  // in-flight map, the cron guards — that a second worker would duplicate.
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  max_restarts: 10,
  // A crash loop should back off rather than hammer, and anything alive for
  // 10s counts as a real start rather than a failed one.
  min_uptime: '10s',
  restart_delay: 4000,
  // Long-running AI jobs allocate large buffers; restart if one truly leaks.
  max_memory_restart: '1G',
  env: { NODE_ENV: 'production', PORT: String(port) },
  // Timestamped, separated, and on disk — so "check the log" is a real
  // instruction rather than a hope.
  error_file: `${__dirname}/logs/${name}.error.log`,
  out_file: `${__dirname}/logs/${name}.out.log`,
  merge_logs: true,
  time: true,
});

module.exports = {
  apps: [
    service('gateway', 'gateway', 3000),
    service('auth-service', 'auth-service', 3001),
    service('learning-service', 'learning-service', 3002),
    service('communication-service', 'communication-service', 3003),
    service('payment-service', 'payment-service', 3004),
    service('analytics-service', 'analytics-service', 3005),
    service('integration-service', 'integration-service', 3006),
  ],
};
