import { ChevronsLeft, ChevronsRight, Menu, MoreHorizontal, Search, X } from 'lucide-react';
import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useDataSource } from '../../data/context';
import { demoData } from '../../data/demo';
import { SCORING_MODEL_VERSION } from '../../domain/scoring';
import type { DataMode } from '../../domain/types';
import { formatDateLong, weekday } from '../../lib/format';
import { cx } from '../../lib/cx';
import { DemoBadge } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { PageSkeleton } from '../ui/PageSkeleton';
import { NAV_MAIN, NAV_SECONDARY, type NavItem } from './nav';

const COLLAPSE_KEY = 'vl.sidebar.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function Brand({ collapsed }: { collapsed?: boolean }) {
  return (
    <div className={cx('brand', collapsed && 'brand--collapsed')}>
      <span className="brand__mark" aria-hidden>
        <svg viewBox="0 0 32 32" width="28" height="28">
          <rect width="32" height="32" rx="8" fill="var(--panel-3)" />
          <path d="M8 10l8 13 8-13" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="16" cy="9" r="2" fill="var(--text)" />
        </svg>
      </span>
      {!collapsed && (
        <span className="brand__text">
          <span className="brand__name">Venture Lab</span>
          <span className="brand__sub">Командный центр</span>
        </span>
      )}
    </div>
  );
}

function NavList({ items, collapsed, onNavigate }: { items: NavItem[]; collapsed?: boolean; onNavigate?: () => void }) {
  return (
    <ul className="nav__list">
      {items.map((item) => (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => cx('nav__link', isActive && 'is-active')}
            title={collapsed ? item.label : undefined}
            onClick={onNavigate}
          >
            <item.icon size={18} strokeWidth={1.8} aria-hidden className="nav__icon" />
            <span className={cx('nav__label', collapsed && 'sr-only')}>{item.label}</span>
            {item.soon && !collapsed && (
              <span className="nav__soon" title="Раздел в разработке">
                <span className="sr-only">скоро</span>
              </span>
            )}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

function GlobalSearch() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [value, setValue] = useState(location.pathname === '/radar' ? (params.get('q') ?? '') : '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/radar?q=${encodeURIComponent(q)}` : '/radar');
  }

  return (
    <form className="gsearch" role="search" onSubmit={submit}>
      <Search size={16} aria-hidden className="gsearch__icon" />
      <label htmlFor="global-search" className="sr-only">
        Поиск идей на радаре
      </label>
      <input
        id="global-search"
        ref={inputRef}
        type="search"
        placeholder="Искать идеи…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
      />
      <kbd className="gsearch__kbd" aria-hidden>
        /
      </kbd>
    </form>
  );
}

function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocus.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('a, button')?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && panel) {
        const els = Array.from(panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      lastFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="drawer" role="presentation">
      <button className="drawer__scrim" aria-label="Закрыть меню" tabIndex={-1} onClick={onClose} />
      <div className="drawer__panel" role="dialog" aria-modal="true" aria-label="Навигация" ref={panelRef} id="mobile-nav">
        <div className="drawer__head">
          <Brand />
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть меню">
            <X size={20} />
          </button>
        </div>
        <nav aria-label="Основная навигация">
          <NavList items={NAV_MAIN} onNavigate={onClose} />
          <div className="nav__sep" />
          <NavList items={NAV_SECONDARY} onNavigate={onClose} />
        </nav>
        <div className="drawer__foot">
          <ModeSwitch />
          <ModeNote />
        </div>
      </div>
    </div>
  );
}

function TabBar({ onMore, moreOpen }: { onMore: () => void; moreOpen: boolean }) {
  const primary = NAV_MAIN.filter((n) => n.primary);
  return (
    <nav className="tabbar" aria-label="Быстрая навигация">
      {primary.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cx('tabbar__item', isActive && 'is-active')}>
          <item.icon size={20} strokeWidth={1.8} aria-hidden />
          <span>{item.label}</span>
        </NavLink>
      ))}
      <button type="button" className={cx('tabbar__item', moreOpen && 'is-active')} onClick={onMore} aria-expanded={moreOpen} aria-controls="mobile-nav">
        <MoreHorizontal size={20} strokeWidth={1.8} aria-hidden />
        <span>Ещё</span>
      </button>
    </nav>
  );
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Explicit DEMO / REAL switch. Changing it never mixes data: the whole source is replaced. */
function ModeSwitch() {
  const { mode, setMode } = useDataSource();
  if (!setMode) return null;
  return (
    <div className="mode-switch">
      <span className="field-label">Источник данных</span>
      <Segmented<DataMode>
        label="Режим данных"
        size="sm"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'real', label: 'Реальные' },
          { value: 'demo', label: 'Демо' },
        ]}
      />
    </div>
  );
}

function ModeNote() {
  const { mode } = useDataSource();
  return mode === 'demo' ? (
    <p>Синтетический набор VL-001, срез на {formatDateLong(demoData.asOf)}. Не факты и не исследования.</p>
  ) : (
    <p>Только импортированные проверенные исследования из локальной базы. Демо-данные не подмешиваются.</p>
  );
}

function ModeBanner() {
  const { mode, setMode } = useDataSource();
  const real = mode === 'real';
  return (
    <div className={cx('mode-banner', real ? 'mode-banner--real' : 'mode-banner--demo')} role="status">
      <span className="mode-banner__dot" aria-hidden />
      <strong>{real ? 'Реальные данные' : 'Демо-режим'}</strong>
      <span className="mode-banner__text">{real ? 'локальная база исследований' : 'синтетический набор — не факты'}</span>
      {setMode && (
        <button type="button" className="mode-banner__switch" onClick={() => setMode(real ? 'demo' : 'real')}>
          {real ? 'Открыть демо' : 'К реальным данным'}
        </button>
      )}
    </div>
  );
}

export function AppShell() {
  const { mode } = useDataSource();
  const dateIso = mode === 'demo' ? demoData.asOf : todayIso();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable — keep in memory only */
    }
  }, [collapsed]);

  // Reset scroll on route change (keeps focus order sane for keyboard users).
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className={cx('shell', collapsed && 'shell--collapsed')}>
      <a className="skip-link" href="#main">
        Перейти к содержимому
      </a>
      <aside className="sidebar" aria-label="Боковая панель">
        <div className="sidebar__top">
          <Brand collapsed={collapsed} />
        </div>
        <nav aria-label="Основная навигация" className="sidebar__nav">
          <NavList items={NAV_MAIN} collapsed={collapsed} />
        </nav>
        <div className="sidebar__bottom">
          <NavList items={NAV_SECONDARY} collapsed={collapsed} />
          {!collapsed && (
            <div className={cx('sidebar__demo', mode === 'real' && 'sidebar__demo--real')}>
              <ModeSwitch />
              <ModeNote />
            </div>
          )}
          <button
            type="button"
            className="sidebar__collapse"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель'}
            aria-pressed={collapsed}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            {!collapsed && <span>Свернуть</span>}
          </button>
        </div>
      </aside>

      <div className="shell__main">
        <header className="topbar">
          <button className="icon-btn topbar__menu" onClick={() => setDrawer(true)} aria-label="Открыть меню" aria-expanded={drawer} aria-controls="mobile-nav">
            <Menu size={20} />
          </button>
          <div className="topbar__brand-m">
            <Brand />
          </div>
          <div className="topbar__context">
            <span className="topbar__date">
              <span className="topbar__weekday">{weekday(dateIso)},</span> {formatDateLong(dateIso)}
            </span>
            <span className="topbar__sep" aria-hidden />
            <span className="topbar__model">Модель оценки {SCORING_MODEL_VERSION}</span>
          </div>
          <GlobalSearch key={location.pathname === '/radar' ? 'radar' : 'other'} />
          <DemoBadge label="Демо-данные" />
          {mode === 'real' && <span className="mode-pill">Реальные данные</span>}
        </header>

        <main id="main" ref={mainRef} className="main" tabIndex={-1}>
          <ModeBanner />
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <TabBar onMore={() => setDrawer(true)} moreOpen={drawer} />
      <MobileDrawer open={drawer} onClose={() => setDrawer(false)} />
    </div>
  );
}
