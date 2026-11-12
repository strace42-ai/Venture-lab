import { Bot, BookOpenText, Briefcase, FlaskConical, Hammer, LayoutDashboard, Radar, Settings2, type LucideIcon } from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the mobile tab bar. */
  primary?: boolean;
  /** Short label for the mobile tab bar. */
  short?: string;
  /** Not implemented in VL-001 — renders an intentional placeholder. */
  soon?: boolean;
}

export const NAV_MAIN: NavItem[] = [
  { to: '/machine', label: 'Автоматический TOP-10', short: 'Авто-TOP', icon: Bot, primary: true },
  { to: '/', label: 'Обзор', icon: LayoutDashboard, primary: true },
  { to: '/radar', label: 'Радар', icon: Radar, primary: true },
  { to: '/validation', label: 'Валидация', icon: FlaskConical, soon: true },
  { to: '/build', label: 'Build Studio', icon: Hammer, soon: true },
  { to: '/portfolio', label: 'Портфель', icon: Briefcase, soon: true },
  { to: '/journal', label: 'Журнал исследований', short: 'Журнал', icon: BookOpenText, primary: true },
];

export const NAV_SECONDARY: NavItem[] = [{ to: '/settings', label: 'Настройки', icon: Settings2, soon: true }];
