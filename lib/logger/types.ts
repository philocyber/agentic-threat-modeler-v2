/**
 * Tipos para el sistema de logging unificado
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Eventos de auditoría que se persisten en BD
 */
export interface LogContext {
  requestId?: string | undefined;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
  // IP forensics metadata (preserved for incident response)
  ipHeaders?: {
    xForwardedFor?: string | null;     // Full chain: "client, proxy1, proxy2, lb"
    xRealIp?: string | null;           // nginx/generic proxies
    cfConnectingIp?: string | null;    // Cloudflare
    trueClientIp?: string | null;      // Akamai/Cloudflare Enterprise
    xClientIp?: string | null;         // Various CDNs
    forwarded?: string | null;         // RFC 7239 (modern standard)
  } | undefined;
  [key: string]: unknown;
}

export interface AuditOptions {
  /**
   * Tipo de evento de auditoría (si se especifica, se persiste en BD)
   */
  eventType: AuditEventType;
  
  /**
   * Metadata adicional específica del evento
   */
  metadata?: Record<string, unknown>;
}
import type { AuditEventType } from '@/lib/db/enums';
