import type { CSSProperties } from 'react';
import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from './wordmark';
import './brand.css';

/**
 * Sistema de marca de "Preguntale a El País".
 * - <Wordmark/>: el "EL PAIS" oficial en SVG, coloreado con currentColor.
 * - <Sparkle/>: estrella de cuatro puntas que señala "con inteligencia artificial".
 * - <BrandBadge/>: lockup apilado en círculo (estilo Club El País): kicker cursivo "Preguntale a" + wordmark + estrella.
 * - <BrandLockup/>: versión horizontal compacta para el encabezado.
 * - <AiMark/>: avatar cuadrado azul con el wordmark y la estrella, para las respuestas del asistente.
 */

export interface WordmarkProps {
  className?: string;
  /** Alto en px; el ancho se deriva de la proporción del wordmark (657:87). */
  height?: number;
  title?: string;
  decorative?: boolean;
}

export function Wordmark({ className, height = 16, title = 'El País', decorative = false }: WordmarkProps) {
  const width = Math.round((height * 657) / 87);
  return (
    <svg
      className={className ? `wordmark ${className}` : 'wordmark'}
      viewBox={WORDMARK_VIEWBOX}
      width={width}
      height={height}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      {WORDMARK_PATHS.map((path, index) => (
        <path key={index} d={path.d} fill="currentColor" fillRule={path.evenOdd ? 'evenodd' : undefined} clipRule={path.evenOdd ? 'evenodd' : undefined} />
      ))}
    </svg>
  );
}

export interface SparkleProps {
  className?: string;
  size?: number;
  /** Con `twin` agrega una segunda estrella pequeña, como en los iconos de asistentes de IA. */
  twin?: boolean;
}

export function Sparkle({ className, size = 16, twin = true }: SparkleProps) {
  return (
    <svg className={className ? `sparkle ${className}` : 'sparkle'} viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d="M12 1.5c.55 5.3 4.2 8.95 9.5 9.5-5.3.55-8.95 4.2-9.5 9.5-.55-5.3-4.2-8.95-9.5-9.5 5.3-.55 8.95-4.2 9.5-9.5Z" fill="currentColor" />
      {twin && <path d="M19.5 15.5c.22 2.1 1.7 3.58 3.8 3.8-2.1.22-3.58 1.7-3.8 3.8-.22-2.1-1.7-3.58-3.8-3.8 2.1-.22 3.58-1.7 3.8-3.8Z" fill="currentColor" opacity="0.85" />}
    </svg>
  );
}

export interface BrandBadgeProps {
  className?: string;
  /** Diámetro en px. */
  size?: number;
  /** Texto del kicker cursivo. */
  kicker?: string;
}

/** Lockup apilado en círculo: "Preguntale a" ✦ arriba, EL PAIS abajo (referencia: Club El País). */
export function BrandBadge({ className, size = 240, kicker = 'Preguntale a' }: BrandBadgeProps) {
  const style = { '--badge-size': `${size}px` } as CSSProperties;
  return (
    <div className={className ? `brand-badge ${className}` : 'brand-badge'} style={style} role="img" aria-label={`${kicker} El País`}>
      <span className="brand-badge__kicker" aria-hidden="true">
        {kicker}
        <Sparkle className="brand-badge__sparkle" size={Math.round(size * 0.09)} />
      </span>
      <Wordmark className="brand-badge__wordmark" height={Math.round(size * 0.115)} decorative />
    </div>
  );
}

export interface BrandLockupProps {
  className?: string;
  kicker?: string;
  /** Alto del wordmark en px. */
  wordmarkHeight?: number;
}

/** Lockup horizontal para encabezados: kicker cursivo + estrella sobre el wordmark, en dos líneas compactas. */
export function BrandLockup({ className, kicker = 'Preguntale a', wordmarkHeight = 15 }: BrandLockupProps) {
  return (
    <span className={className ? `brand-lockup ${className}` : 'brand-lockup'}>
      <span className="brand-lockup__kicker">
        {kicker}
        <Sparkle className="brand-lockup__sparkle" size={12} twin={false} />
      </span>
      <Wordmark className="brand-lockup__wordmark" height={wordmarkHeight} title={`${kicker} El País`} />
    </span>
  );
}

export interface AiMarkProps {
  className?: string;
  size?: number;
  title?: string;
}

/**
 * Avatar del asistente: cuadrado azul con el wordmark (como el ícono de la app) y una
 * estrella en la esquina que indica "generado con IA". Reemplazable por el logo oficial
 * de El País IA cuando exista.
 */
export function AiMark({ className, size = 32, title = 'El País, respuesta generada con inteligencia artificial' }: AiMarkProps) {
  const style = { '--mark-size': `${size}px` } as CSSProperties;
  return (
    <span className={className ? `ai-mark ${className}` : 'ai-mark'} style={style} role="img" aria-label={title}>
      <span className="ai-mark__tile" aria-hidden="true">
        <Wordmark className="ai-mark__wordmark" height={Math.max(4, Math.round(size * 0.13))} decorative />
      </span>
      <span className="ai-mark__badge" aria-hidden="true">
        <Sparkle size={Math.max(8, Math.round(size * 0.42))} twin={false} />
      </span>
    </span>
  );
}
