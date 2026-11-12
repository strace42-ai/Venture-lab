import { ArrowRight, BookOpenText, Briefcase, Check, FlaskConical, Hammer, Settings2, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DemoBadge } from '../components/ui/primitives';

export type PlaceholderKey = 'validation' | 'build' | 'portfolio' | 'journal' | 'settings';

interface PlaceholderSpec {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  lede: string;
  sprint: string;
  will: string[];
  rule: string;
  preview: { label: string; hint: string }[];
  cta: { to: string; label: string };
}

const SPECS: Record<PlaceholderKey, PlaceholderSpec> = {
  validation: {
    icon: FlaskConical,
    eyebrow: 'Лаборатория валидации',
    title: 'Проверяем спрос до того, как писать код',
    lede: 'Здесь будут эксперименты: гипотеза, оффер, канал, интервью, офферы, предоплаты и расходы — с честными знаменателями конверсий.',
    sprint: 'Спринт 3',
    will: ['Карточка эксперимента с порогом успеха и стоп-правилом', 'Учёт контактов, ответов, интервью и офферов', 'Платёж засчитывается только после ручной проверки', 'Решение: продолжить, изменить, остановить — с обоснованием'],
    rule: 'Устное обещание ≠ подтверждённая продажа. Опрос о намерениях ≠ платёжный сигнал.',
    preview: [
      { label: 'Гипотеза', hint: '≥ 3 из 10 оплатят пилот' },
      { label: 'Воронка', hint: 'контакты → интервью → оплаты' },
      { label: 'Решение', hint: 'продолжить / стоп' },
    ],
    cta: { to: '/', label: 'Превью воронки на обзоре' },
  },
  build: {
    icon: Hammer,
    eyebrow: 'Build Studio',
    title: 'Сборка с ИИ-агентами под контролем основателя',
    lede: 'Текущая задача, ветка, PR, статус CI, замечания ревьюера и handoff-отчёт — в одном месте, только для чтения из GitHub.',
    sprint: 'Спринт 4',
    will: ['Авторизованная текущая задача и её версия', 'Ветка, PR и результаты CI (read-only)', 'Замечания независимого ревью', 'Handoff-отчёт и рекомендованный следующий шаг'],
    rule: 'Слияние и деплой — только с одобрения основателя. Никаких выдуманных статусов агентов.',
    preview: [
      { label: 'Задача', hint: 'tasks/current-task.md' },
      { label: 'PR / CI', hint: 'нет подключения' },
      { label: 'Handoff', hint: 'handoff/latest.md' },
    ],
    cta: { to: '/', label: 'Превью сборок на обзоре' },
  },
  portfolio: {
    icon: Briefcase,
    eyebrow: 'Портфель',
    title: 'Запущенные продукты и их реальная экономика',
    lede: 'Выручка, расходы на LLM и хостинг, валовая маржа и удержание — только после первых подтверждённых оплат.',
    sprint: 'Спринт 5',
    will: ['Жизненный цикл проектов и решения по портфелю', 'Выручка и GMV раздельно, валюта явно (RUB / USD)', 'Затраты на API и инфраструктуру', 'Удержание и повторные платежи'],
    rule: 'Пока нет подтверждённых оплат, этот раздел пуст намеренно — без выдуманной выручки.',
    preview: [
      { label: 'Выручка', hint: 'нет данных' },
      { label: 'Маржа', hint: 'нет данных' },
      { label: 'Удержание', hint: 'нет данных' },
    ],
    cta: { to: '/radar', label: 'Перейти к радару' },
  },
  journal: {
    icon: BookOpenText,
    eyebrow: 'Журнал исследований',
    title: 'Каждый прогон исследования — с датой и источниками',
    lede: 'Датированные прогоны, новые и отклонённые кандидаты, изменения источников и сохранённые срезы топ-10 для сравнения.',
    sprint: 'Спринт 2',
    will: ['Лог прогонов с рынками и стратегией поиска', 'Принятые и отклонённые изменения оценок', 'Снимки топ-10 на каждую дату', 'Разделение проверенных человеком и машинных утверждений'],
    rule: 'Движение в рейтинге показывается только при наличии сохранённого предыдущего среза.',
    preview: [
      { label: 'Прогон', hint: 'дата · рынки · источники' },
      { label: 'Изменения', hint: 'принято / отклонено' },
      { label: 'Срез топ-10', hint: 'история рангов' },
    ],
    cta: { to: '/', label: 'Превью пульса на обзоре' },
  },
  settings: {
    icon: Settings2,
    eyebrow: 'Настройки',
    title: 'Модель оценки, интеграции и лимиты',
    lede: 'Версии весов модели (без скрытых изменений), будущие интеграции, валюта и лимиты расходов.',
    sprint: 'Позже',
    will: ['Просмотр версии модели и весов', 'Интеграции — только после одобрения основателя', 'Валюта по умолчанию', 'Лимиты затрат на платные API'],
    rule: 'Веса модели v1.0 фиксированы. Любая смена весов — новая версия модели.',
    preview: [
      { label: 'Модель', hint: 'v1.0 · 12 критериев' },
      { label: 'Интеграции', hint: 'не подключены' },
      { label: 'Лимиты', hint: 'платные API выключены' },
    ],
    cta: { to: '/', label: 'На обзор' },
  },
};

export default function PlaceholderPage({ which }: { which: PlaceholderKey }) {
  const s = SPECS[which];
  const Icon = s.icon;
  return (
    <div className="page page--placeholder">
      <header className="page-head">
        <div className="eyebrow">
          {s.eyebrow}
          <span className="soon-pill">{s.sprint}</span>
        </div>
        <h1 className="display display--sm">{s.title}</h1>
        <p className="page-head__lede">{s.lede}</p>
      </header>

      <div className="ph">
        <section className="panel ph__main" aria-labelledby="ph-will">
          <div className="ph__icon" aria-hidden>
            <Icon size={22} strokeWidth={1.6} />
          </div>
          <h2 id="ph-will" className="panel__title">
            Что здесь появится
          </h2>
          <ul className="ph__list">
            {s.will.map((w) => (
              <li key={w}>
                <Check size={14} aria-hidden />
                {w}
              </li>
            ))}
          </ul>
          <p className="note">{s.rule}</p>
          <div className="ph__status">
            <span>Раздел ещё не реализован — это намеренная заглушка VL-001, а не сломанная функция.</span>
          </div>
          <Link to={s.cta.to} className="link-cta">
            {s.cta.label} <ArrowRight size={14} aria-hidden />
          </Link>
        </section>

        <section className="panel ph__preview" aria-label="Эскиз будущей структуры">
          <div className="ph__preview-head">
            <span className="eyebrow">Эскиз структуры</span>
            <DemoBadge compact label="макет" />
          </div>
          <ol className="ph__blocks">
            {s.preview.map((p, i) => (
              <li key={p.label} className="ph__block">
                <span className="ph__num num">{String(i + 1).padStart(2, '0')}</span>
                <span className="ph__blabel">{p.label}</span>
                <span className="ph__bhint">{p.hint}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
