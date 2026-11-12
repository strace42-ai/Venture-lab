import { BookOpenText, Briefcase, FlaskConical, Hammer, LayoutDashboard, Radar, Settings2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile tab bar. */
  primary?: boolean;
  /** Not implemented in VL-001 — renders an intentional placeholder. */
  soon?: boolean;
}

export const NAV_MAIN: NavItem[] = [
  { to: '/', label: 'Обзор', icon: LayoutDashboard, primary: true },
  { to: '/radar', label: 'Радар', icon: Radar, primary: true },
  { to: '/validation', label: 'Валидация', icon: FlaskConical, primary: true, soon: true },
  { to: '/build', label: 'Build Studio', icon: Hammer, soon: true },
  { to: '/portfolio', label: 'Портфель', icon: Briefcase, soon: true },
  { to: '/journal', label: 'Журнал исследований', icon: BookOpenText, soon: true },
];

export const NAV_SECONDARY: NavItem[] = [{ to: '/settings', label: 'Настройки', icon: Settings2, soon: true }];
