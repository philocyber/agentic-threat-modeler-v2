/**
 * Sistema de logging unificado
 * 
 * Combina logs operacionales (console.log estructurado) con logs de auditoría (BD).
 * 
 * Uso básico (solo operacional):
 * logger.info('Analysis started', { analysisId });
 * 
 * Uso con auditoría:
 * logger.info('Analysis requested', { analysisId }, {
 *   audit: { eventType: 'analysis_requested' }
 * });
 * 
 * IMPORTANT: Uses AsyncLocalStorage to isolate context per request.
 * Each concurrent request has its own isolated context (actor, IP, etc.)
 */

import { AsyncLocalStorage } from 'async_hooks';
import { insertAuditLog } from '@/lib/storage/audit';
import type { LogLevel, LogContext, AuditOptions } from './types';
import { clientIpFromRequest } from '@/lib/utils/rate-limit';

interface LogOptions {
  /**
   * Si se especifica, el log también se persiste en BD como evento de auditoría
   */
  audit?: AuditOptions;
}

class Logger {
  private asyncLocalStorage = new AsyncLocalStorage<LogContext>();

  /**
   * Establece contexto que se incluirá en todos los logs del request actual.
   * Usa AsyncLocalStorage para aislar el contexto por request concurrente.
   */
  setContext(context: LogContext) {
    const currentContext = this.asyncLocalStorage.getStore() ?? {};
    const newContext = { ...currentContext, ...context };
    this.asyncLocalStorage.enterWith(newContext);
  }

  /**
   * Limpia el contexto del request actual
   */
  clearContext() {
    this.asyncLocalStorage.enterWith({});
  }

  /**
   * Obtiene el contexto del request actual
   */
  getContext(): LogContext {
    return { ...(this.asyncLocalStorage.getStore() ?? {}) };
  }

  private async log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    options?: LogOptions
  ) {
    const timestamp = new Date().toISOString();
    const context = this.getContext(); // Get isolated context for this request
    const logData = {
      timestamp,
      level,
      message,
      ...context,
      ...meta,
    };

    // 1. SIEMPRE hacer console.log estructurado (logs operacionales)
    const method =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

    method(JSON.stringify(logData));

    // 2. OPCIONALMENTE persistir en BD (logs de auditoría)
    if (options?.audit) {
      await this.persistAuditLog(options.audit, message, meta, context);
    }
  }

  /**
   * Persiste log de auditoría en la base de datos
   */
  private async persistAuditLog(
    audit: AuditOptions,
    message: string,
    meta?: Record<string, unknown>,
    context?: LogContext
  ): Promise<void> {
    try {
      // Include IP forensics metadata if available (for incident response)
      const auditMetadata: Record<string, unknown> = {
        message,
        ...meta,
        ...audit.metadata,
      };

      // Preserve full IP chain for forensics (don't lose evidence)
      if (context?.ipHeaders) {
        auditMetadata.ipHeaders = context.ipHeaders;
      }

      await insertAuditLog({
        eventType: audit.eventType,
        ipAddress: context?.ipAddress ?? null,  // Trusted IP (for queries/blocking)
        userAgent: context?.userAgent ?? null,
        metadata: auditMetadata,
      });
    } catch (error) {
      // No fallar el request principal si falla el audit log
      console.error('[AUDIT_LOG_FAILED]', {
        error: error instanceof Error ? error.message : String(error),
        eventType: audit.eventType,
      });
    }
  }

  /**
   * Log de debug (solo en development)
   */
  debug(message: string, meta?: Record<string, unknown>, options?: LogOptions) {
    if (process.env.NODE_ENV === 'development') {
      this.log('debug', message, meta, options);
    }
  }

  /**
   * Log informativo
   */
  info(message: string, meta?: Record<string, unknown>, options?: LogOptions) {
    this.log('info', message, meta, options);
  }

  /**
   * Log de advertencia
   */
  warn(message: string, meta?: Record<string, unknown>, options?: LogOptions) {
    this.log('warn', message, meta, options);
  }

  /**
   * Log de error
   */
  error(message: string, meta?: Record<string, unknown>, options?: LogOptions) {
    this.log('error', message, meta, options);
  }

  /**
   * Helper para extraer metadata del request (IP, User-Agent)
   * 
   * `ipAddress` uses the same TRUSTED_PROXY_HOPS policy as rate limiting.
   * Raw forwarding headers remain available in `ipHeaders` for forensics, but
   * are never promoted to a trusted address when proxy trust is unset.
   */
  extractRequestMetadata(req: Request): Pick<LogContext, 'ipAddress' | 'userAgent' | 'ipHeaders'> {
    // Extract all IP-related headers (some may be null)
    const xForwardedFor = req.headers.get('x-forwarded-for');
    const xRealIp = req.headers.get('x-real-ip');
    const cfConnectingIp = req.headers.get('cf-connecting-ip');
    const trueClientIp = req.headers.get('true-client-ip');
    const xClientIp = req.headers.get('x-client-ip');
    const forwarded = req.headers.get('forwarded');

    const trustedAddress = clientIpFromRequest(req.headers);
    const ipAddress = trustedAddress === 'unknown' ? undefined : trustedAddress;

    // Preserve ALL headers for forensics (incident response needs full context)
    const ipHeaders: LogContext['ipHeaders'] = {
      xForwardedFor: xForwardedFor ?? null,
      xRealIp: xRealIp ?? null,
      cfConnectingIp: cfConnectingIp ?? null,
      trueClientIp: trueClientIp ?? null,
      xClientIp: xClientIp ?? null,
      forwarded: forwarded ?? null,
    };

    return {
      ipAddress,
      userAgent: req.headers.get('user-agent') ?? undefined,
      ipHeaders,
    };
  }
}

/**
 * Instancia singleton del logger
 */
export const logger = new Logger();
