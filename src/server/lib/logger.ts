import pino from 'pino';
const isDev = (process.env.NODE_ENV ?? 'development') !== 'production';
const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } } } : {}),
});
export default logger;
export function serverLogger() { return logger.child({ component: 'server' }); }
export function agentLogger(agentId: string, extra?: Record<string, unknown>) { return logger.child({ component: 'agent', agentId, ...extra }); }
export function queueLogger(extra?: Record<string, unknown>) { return logger.child({ component: 'queue', ...extra }); }
export function watchdogLogger(extra?: Record<string, unknown>) { return logger.child({ component: 'watchdog', ...extra }); }
export function workflowLogger(workflowId: string, extra?: Record<string, unknown>) { return logger.child({ component: 'workflow', workflowId, ...extra }); }
export function recoveryLogger(extra?: Record<string, unknown>) { return logger.child({ component: 'recovery', ...extra }); }
export function socketLogger(extra?: Record<string, unknown>) { return logger.child({ component: 'socket', ...extra }); }
export function maintenanceLogger(extra?: Record<string, unknown>) { return logger.child({ component: 'maintenance', ...extra }); }
