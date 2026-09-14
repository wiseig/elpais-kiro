/**
 * Íconos del riel, en línea para no sumar una dependencia. Trazo de 1,6 px sobre una grilla
 * de 24, como los del backoffice del PPS: se leen bien a 16 px y heredan `currentColor`.
 */
interface IconProps {
  className?: string;
}

function Svg({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconInicio(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19V9.5L12 4l8 5.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z" />
    </Svg>
  );
}

export function IconPreguntas(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.4A8 8 0 1 1 21 12Z" />
      <path d="M9.8 9.4a2.2 2.2 0 1 1 3 2.1v1.2" />
      <path d="M12.8 15.6h0" />
    </Svg>
  );
}

export function IconTendencias(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 17.5 9.5 12l3.5 3.5L20 8" />
      <path d="M15.5 8H20v4.5" />
    </Svg>
  );
}

export function IconCorpus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18a1 1 0 0 1 1 1v13.5" />
      <path d="M6.5 20H19" />
      <path d="M5 5.5V18a2 2 0 0 0 2 2" />
      <path d="M9 8.5h6M9 12h6" />
    </Svg>
  );
}

export function IconLectores(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 5 18.5V20" />
      <circle cx="10.5" cy="8" r="3.2" />
      <path d="M19 20v-1.5a3.5 3.5 0 0 0-2.5-3.35" />
      <path d="M15.2 5a3.2 3.2 0 0 1 0 6" />
    </Svg>
  );
}

export function IconPersonalizacion(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5c.6 4.2 3.3 6.9 7.5 7.5-4.2.6-6.9 3.3-7.5 7.5-.6-4.2-3.3-6.9-7.5-7.5 4.2-.6 6.9-3.3 7.5-7.5Z" />
    </Svg>
  );
}

export function IconCalidad(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5 5.5 6v5.4c0 4 2.7 7.6 6.5 8.6 3.8-1 6.5-4.6 6.5-8.6V6L12 3.5Z" />
      <path d="m9.3 12 1.9 1.9 3.5-3.6" />
    </Svg>
  );
}

export function IconGuardrails(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="10.5" width="15" height="9" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
      <path d="M12 14v2.5" />
    </Svg>
  );
}

export function IconCanales(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h4l2.5 5 3-11 2.5 6h4" />
    </Svg>
  );
}

export function IconCostos(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.3 9.3a2.6 2.6 0 0 0-2.3-1.2c-1.4 0-2.4.8-2.4 1.9 0 2.6 4.8 1.4 4.8 4 0 1.2-1.1 2-2.5 2a2.7 2.7 0 0 1-2.4-1.3" />
      <path d="M12 6.6v10.8" />
    </Svg>
  );
}

export function IconConfiguracion(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0V20a1.6 1.6 0 0 0-2.7-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 13.3H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.3 6.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10.7 4V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H20a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </Svg>
  );
}

export function IconAuditoria(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" />
      <path d="M13.5 4v4.5H18" />
      <path d="M9 13h6M9 16.5h4" />
    </Svg>
  );
}

export function IconTrabajos(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.8V12l2.8 1.7" />
    </Svg>
  );
}

export function IconCuenta(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </Svg>
  );
}

export function IconBuscar(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}

export function IconSalir(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 7V5.5a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20h7a1.5 1.5 0 0 0 1.5-1.5V17" />
      <path d="M11 12h9m0 0-3-3m3 3-3 3" />
    </Svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconCerrar(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconAlertas(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 15.5V10a6 6 0 1 0-12 0v5.5L4.5 18h15Z" />
      <path d="M10 21h4" />
    </Svg>
  );
}

export function IconCorreo(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 5.5L20 7" />
    </Svg>
  );
}

export function IconUsuarios(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 6" />
      <path d="M17.2 14.4A4.6 4.6 0 0 1 20.5 19" />
    </Svg>
  );
}
