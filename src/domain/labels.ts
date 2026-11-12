import type { BuildStage, CompetitorPlaceholder, ExperimentStatus, RiskFlag, Stage } from './types';

export const STAGE_LABEL: Record<Stage, string> = {
  discovered: 'Обнаружена',
  researching: 'Исследование',
  scored: 'Оценена',
  validation_planned: 'Валидация запланирована',
  validating: 'Валидация',
  paid_signal: 'Платёжный сигнал',
  build_candidate: 'Кандидат в сборку',
  building: 'Сборка',
  launched: 'Запущена',
  monetizing: 'Монетизация',
  paused: 'Пауза',
  rejected: 'Отклонена',
};

/** Order for the lifecycle funnel and the stage filter. */
export const STAGE_ORDER: Stage[] = [
  'discovered',
  'researching',
  'scored',
  'validation_planned',
  'validating',
  'paid_signal',
  'build_candidate',
  'building',
  'launched',
  'monetizing',
  'paused',
  'rejected',
];

export type StageTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger';

export const STAGE_TONE: Record<Stage, StageTone> = {
  discovered: 'neutral',
  researching: 'neutral',
  scored: 'neutral',
  validation_planned: 'accent',
  validating: 'accent',
  paid_signal: 'success',
  build_candidate: 'success',
  building: 'success',
  launched: 'success',
  monetizing: 'success',
  paused: 'warn',
  rejected: 'danger',
};

export const RISK_LABEL: Record<RiskFlag, string> = {
  legal: 'Юридический риск',
  lockedApi: 'Закрытые API',
  demandUnverified: 'Спрос не подтверждён',
  coldStart: 'Холодный старт дистрибуции',
  networkEffect: 'Зависит от сетевого эффекта',
  lowRetention: 'Низкое удержание',
  dataPrivacy: 'Персональные данные (152-ФЗ)',
  highCogs: 'Высокая себестоимость',
  competitionUnverified: 'Конкуренция не проверена',
};

/** Flags that force «требует ревью» regardless of score. */
export const CRITICAL_RISKS: ReadonlySet<RiskFlag> = new Set<RiskFlag>(['legal', 'lockedApi']);

export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  planned: 'Запланирован',
  running: 'Идёт',
  completed: 'Завершён',
};

export const BUILD_STAGE_LABEL: Record<BuildStage, string> = {
  spec: 'Спецификация',
  prototype: 'Прототип',
  review: 'Ревью',
  paused: 'Пауза',
};

export const COMPETITOR_KIND_LABEL: Record<CompetitorPlaceholder['kind'], string> = {
  direct: 'Прямой',
  adjacent: 'Смежный',
  substitute: 'Заменитель',
};

export const COVERAGE_LABEL: Record<CompetitorPlaceholder['coverage'], string> = {
  high: 'Покрывает',
  partial: 'Частично',
  low: 'Слабо',
  unknown: 'Неизвестно',
};

export function confidenceBand(c: number): { label: string; tone: StageTone } {
  if (c >= 70) return { label: 'Высокая', tone: 'success' };
  if (c >= 50) return { label: 'Средняя', tone: 'accent' };
  return { label: 'Низкая', tone: 'warn' };
}
