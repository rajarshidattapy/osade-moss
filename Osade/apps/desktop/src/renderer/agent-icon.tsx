import { useId, type JSX } from 'react';

import { agentColor } from './agent-color.js';
import { agentInitials } from './lanes.js';

/**
 * Brand marks for coding agents — paths from docs/logo.tsx.
 *
 * Tailwind `className` is dropped; the desktop renderer does not ship that utility set.
 * Gradient ids are unique per mount so two Codex rows do not share a fill.
 */

const BRANDS = [
  'claude',
  'cursor',
  'codex',
  'openai',
  'copilot',
  'gemini',
  'opencode',
  'aider',
  'grok',
  'goose',
  'cline',
  'amp',
  'continue',
  'devin',
] as const;

export function hasBrandLogo(name: string): boolean {
  const n = name.toLowerCase();
  return BRANDS.some((brand) => n.includes(brand));
}

export function AgentMark({
  name,
  size = 16,
}: {
  name: string;
  size?: number;
}): JSX.Element {
  if (!hasBrandLogo(name)) {
    return (
      <span
        style={{
          display: 'flex',
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          background: agentColor(name),
          color: 'var(--bg-0)',
          borderRadius: 2,
          fontSize: Math.max(8, Math.round(size * 0.5)),
          fontWeight: 600,
          letterSpacing: 0.2,
          lineHeight: 1,
          fontFamily: "ui-sans-serif, system-ui, 'Segoe UI', sans-serif",
        }}
      >
        {agentInitials(name)}
      </span>
    );
  }
  return <AgentIcon name={name} size={size} />;
}

export function AgentIcon({ name, size = 16 }: { name: string; size?: number }): JSX.Element {
  const uid = useId().replace(/:/g, '');
  const n = name.toLowerCase();
  const box = { width: size, height: size, display: 'block' as const };

  if (n.includes('claude')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
          fill="#D97757"
        />
      </svg>
    );
  }

  if (n.includes('cursor')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"
          fill="#FFFFFF"
        />
      </svg>
    );
  }

  if (n.includes('codex') || n.includes('openai')) {
    const grad = `codex-${uid}`;
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
          fill={`url(#${grad})`}
        />
        <defs>
          <linearGradient id={grad} x1="12" y1="3" x2="12" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#B1A7FF" />
            <stop offset="0.5" stopColor="#7A9DFF" />
            <stop offset="1" stopColor="#3941FF" />
          </linearGradient>
        </defs>
      </svg>
    );
  }

  if (n.includes('copilot')) {
    const g0 = `copilot-0-${uid}`;
    const g1 = `copilot-1-${uid}`;
    const g2 = `copilot-2-${uid}`;
    const g4 = `copilot-4-${uid}`;
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M17.533 1.829A2.528 2.528 0 0015.11 0h-.737a2.531 2.531 0 00-2.484 2.087l-1.263 6.937.314-1.08a2.528 2.528 0 012.424-1.833h4.284l1.797.706 1.731-.706h-.505a2.528 2.528 0 01-2.423-1.829l-.715-2.453z"
          fill={`url(#${g0})`}
          transform="translate(0 1)"
        />
        <path
          d="M6.726 20.16A2.528 2.528 0 009.152 22h1.566c1.37 0 2.49-1.1 2.525-2.48l.17-6.69-.357 1.228a2.528 2.528 0 01-2.423 1.83h-4.32l-1.54-.842-1.667.843h.497c1.124 0 2.113.75 2.426 1.84l.697 2.432z"
          fill={`url(#${g1})`}
          transform="translate(0 1)"
        />
        <path
          d="M15 0H6.252c-2.5 0-4 3.331-5 6.662-1.184 3.947-2.734 9.225 1.75 9.225H6.78c1.13 0 2.12-.753 2.43-1.847.657-2.317 1.809-6.359 2.713-9.436.46-1.563.842-2.906 1.43-3.742A1.97 1.97 0 0115 0"
          fill={`url(#${g2})`}
          transform="translate(0 1)"
        />
        <path
          d="M9 22h8.749c2.5 0 4-3.332 5-6.663 1.184-3.948 2.734-9.227-1.75-9.227H17.22c-1.129 0-2.12.754-2.43 1.848a1149.2 1149.2 0 01-2.713 9.437c-.46 1.564-.842 2.907-1.43 3.743A1.97 1.97 0 019 22"
          fill={`url(#${g4})`}
          transform="translate(0 1)"
        />
        <defs>
          <radialGradient id={g0} cx="85.44%" cy="100.653%" fx="85.44%" fy="100.653%" r="105.116%">
            <stop offset="9.6%" stopColor="#00AEFF" />
            <stop offset="77.3%" stopColor="#2253CE" />
            <stop offset="100%" stopColor="#0736C4" />
          </radialGradient>
          <radialGradient id={g1} cx="18.143%" cy="32.928%" fx="18.143%" fy="32.928%" r="95.612%">
            <stop offset="0%" stopColor="#FFB657" />
            <stop offset="63.4%" stopColor="#FF5F3D" />
            <stop offset="92.3%" stopColor="#C02B3C" />
          </radialGradient>
          <linearGradient id={g2} x1="39.465%" y1="12.117%" x2="46.884%" y2="103.774%">
            <stop offset="15.6%" stopColor="#0D91E1" />
            <stop offset="48.7%" stopColor="#52B471" />
            <stop offset="65.2%" stopColor="#98BD42" />
            <stop offset="93.7%" stopColor="#FFC800" />
          </linearGradient>
          <radialGradient id={g4} cx="82.987%" cy="-9.792%" fx="82.987%" fy="-9.792%" r="140.622%">
            <stop offset="6.6%" stopColor="#8C48FF" />
            <stop offset="50%" stopColor="#F2598A" />
            <stop offset="89.6%" stopColor="#FFB152" />
          </radialGradient>
        </defs>
      </svg>
    );
  }

  if (n.includes('gemini')) {
    const grad = `gemini-${uid}`;
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
          fill="#3186FF"
        />
        <path
          d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
          fill={`url(#${grad})`}
        />
        <defs>
          <linearGradient id={grad} x1="7" y1="15.5" x2="11" y2="12" gradientUnits="userSpaceOnUse">
            <stop stopColor="#08B962" />
            <stop offset="1" stopColor="#08B962" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
    );
  }

  if (n.includes('opencode')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path fillRule="evenodd" clipRule="evenodd" d="M16 6H8v12h8V6zm4 16H4V2h16v20z" fill="#38BDF8" />
      </svg>
    );
  }

  if (n.includes('aider')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M4.5 19.5L19.5 12L4.5 4.5L7.5 12L4.5 19.5Z"
          fill="#F59E0B"
          stroke="#FBBF24"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (n.includes('grok')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M18.244 3.5h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 23H1.68l7.73-8.835L1.254 3.5H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 5.376H5.117z"
          fill="#FFFFFF"
        />
      </svg>
    );
  }

  if (n.includes('goose')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <circle cx="12" cy="9" r="4.5" fill="#10B981" />
        <path d="M7 14c0 3 2.5 5.5 5 5.5s5-2.5 5-5.5H7z" fill="#34D399" />
        <circle cx="10.5" cy="8.5" r="1" fill="#FFFFFF" />
        <path d="M14 9l3 1-3 1V9z" fill="#F59E0B" />
      </svg>
    );
  }

  if (n.includes('cline')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <rect x="5.5" y="7.5" width="13" height="10" rx="3" stroke="#38BDF8" strokeWidth="2" />
        <circle cx="9.5" cy="12.5" r="1.5" fill="#38BDF8" />
        <circle cx="14.5" cy="12.5" r="1.5" fill="#38BDF8" />
        <path d="M12 4.5v3" stroke="#38BDF8" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (n.includes('amp')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path
          d="M13 3.5L5.5 13.5H12L11 20.5L18.5 10.5H12L13 3.5Z"
          fill="#F43F5E"
          stroke="#FDA4AF"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (n.includes('continue')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <path d="M7 6l6 6-6 6V6zM13 6l6 6-6 6V6z" fill="#EC4899" />
      </svg>
    );
  }

  if (n.includes('devin')) {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
        <rect x="5" y="5" width="14" height="14" rx="3" fill="#0EA5E9" />
        <path d="M9 9h6v6H9z" fill="#FFFFFF" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" style={box}>
      <circle cx="12" cy="12" r="6" stroke="#A1A1AA" strokeWidth="2" />
    </svg>
  );
}
