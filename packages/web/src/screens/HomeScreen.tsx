import { useId } from 'react';
import type { DashboardDto, RateDto } from '../api/types';
import { MEMORY_STATUSES, MEMORY_TYPES, QUARANTINE_CRITERIA } from '../api/types';
import { StatBar } from '../components/StatBar';
import { ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { formatDateTime } from '../lib/format';
import { formatPercent, rateCountText } from '../lib/insights';
import { METRICS, quarantineCriterionLabel, statusLabel, typeLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

function Header({ onRefresh }: { onRefresh?: () => void }) {
  return (
    <>
      <div className="toolbar">
        <h1 className="screen__title" tabIndex={-1}>
          Inicio
        </h1>
        {onRefresh && (
          <button type="button" className="btn btn--secondary" onClick={onRefresh}>
            Actualizar
          </button>
        )}
      </div>
      <p className="screen__subtitle">
        Estado del gobierno de la memoria: qué decidió el Juez, qué corrigieron las personas y qué
        queda pendiente. Vista de solo lectura.
      </p>
    </>
  );
}

export function HomeScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <Home {...props} />;
}

function Home({ api, projectId, navigate }: ScreenProps) {
  const state = useAsync(() => api.getDashboard(projectId), [api, projectId]);
  if (state.status === 'loading') {
    return (
      <>
        <Header />
        <Loading />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        <Header />
        <ErrorMessage error={state.error} onRetry={state.reload} />
      </>
    );
  }
  return (
    <>
      <Header onRefresh={state.reload} />
      <Dashboard d={state.data} navigate={navigate} />
    </>
  );
}

function Dashboard({ d, navigate }: { d: DashboardDto; navigate: ScreenProps['navigate'] }) {
  const id = useId();
  const activeTotal = d.memories.byStatus.active;
  const o = d.judge.outcomes;
  const outcomeMax = Math.max(
    o.accepted,
    o.uncertain,
    o.rejected,
    o.pipelineBlocked,
    o.notEvaluated,
  );
  const l = d.judge.labels;

  return (
    <div className="insights">
      <section className="card" aria-labelledby={`${id}-kpi`}>
        <h2 id={`${id}-kpi`} className="card__title">
          Indicadores del Juez con datos reales
        </h2>
        <div className="kpi-pair">
          <Indicator
            title={METRICS.falsePositiveTitle}
            rate={d.judge.falsePositive}
            definition={METRICS.falsePositiveDefinition}
          />
          <Indicator
            title={METRICS.falseNegativeTitle}
            rate={d.judge.falseNegative}
            definition={METRICS.falseNegativeDefinition}
          />
        </div>
        <p className="insights__gap">
          Sin etiqueta (no medible): {d.judge.unlabeled.autoApplied} aplicadas automáticamente sin
          revisión, {d.judge.unlabeled.judgeRejectedNotRestored} rechazos del Juez no restaurados.
        </p>
        <p className="muted small">{METRICS.bias}</p>
        <p className="muted small">{METRICS.synthetic}</p>
        <p className="muted small">Calculado: {formatDateTime(d.generatedAt)}</p>
      </section>

      <div className="insights-grid">
        <section className="card" aria-labelledby={`${id}-memory`}>
          <h2 id={`${id}-memory`} className="card__title">
            Memoria
          </h2>
          <p className="kpi__value">{d.memories.total}</p>
          <p className="muted small">unidades en total</p>
          <h3 className="section__label insights__sublabel">Por estado</h3>
          {MEMORY_STATUSES.map((s) => (
            <StatBar
              key={s}
              label={statusLabel(s)}
              value={d.memories.byStatus[s]}
              max={d.memories.total}
              tone={s === 'active' ? 'ok' : 'neutral'}
            />
          ))}
          <h3 className="section__label insights__sublabel">Activas por tipo</h3>
          {MEMORY_TYPES.map((t) => (
            <StatBar
              key={t}
              label={typeLabel(t)}
              value={d.memories.activeByType[t]}
              max={activeTotal}
            />
          ))}
        </section>

        <section className="card" aria-labelledby={`${id}-pending`}>
          <h2 id={`${id}-pending`} className="card__title">
            Pendiente
          </h2>
          <div className="kpi-row">
            <div>
              <p className="kpi__value">{d.queue.pending}</p>
              <p className="muted small">en la cola de revisión</p>
            </div>
            <dl className="dl">
              <dt>Dudosas del Juez</dt>
              <dd>{d.queue.uncertain}</dd>
              <dt>Revisión obligatoria</dt>
              <dd>{d.queue.mandatory}</dd>
            </dl>
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => navigate({ name: 'review' })}
          >
            Ir a la cola de revisión
          </button>
          <div className="kpi-row insights__gap">
            <div>
              <p className="kpi__value">{d.quarantine.active}</p>
              <p className="muted small">en cuarentena</p>
            </div>
            <dl className="dl">
              {QUARANTINE_CRITERIA.map((c) => (
                <Pair
                  key={c}
                  label={quarantineCriterionLabel(c)}
                  value={d.quarantine.byCriterion[c]}
                />
              ))}
            </dl>
          </div>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => navigate({ name: 'quarantine' })}
          >
            Ir a cuarentena
          </button>
        </section>

        <section className="card" aria-labelledby={`${id}-outcomes`}>
          <h2 id={`${id}-outcomes`} className="card__title">
            Decisiones del Juez (últimos {d.windowDays} días)
          </h2>
          <p className="muted small insights__note">
            Propuestas de agentes evaluadas en promociones de los últimos {d.windowDays} días.
          </p>
          <StatBar label="Aceptadas" value={o.accepted} max={outcomeMax} tone="ok" />
          <StatBar label="Dudosas (a revisión)" value={o.uncertain} max={outcomeMax} tone="warn" />
          <StatBar
            label="Rechazadas por el Juez"
            value={o.rejected}
            max={outcomeMax}
            tone="danger"
          />
          <StatBar
            label="Bloqueadas por la sanitización"
            value={o.pipelineBlocked}
            max={outcomeMax}
            tone="neutral"
          />
          <StatBar
            label="Sin evaluación del Juez"
            value={o.notEvaluated}
            max={outcomeMax}
            tone="neutral"
          />
        </section>

        <section className="card" aria-labelledby={`${id}-labels`}>
          <h2 id={`${id}-labels`} className="card__title">
            Correcciones humanas (últimos {d.windowDays} días)
          </h2>
          <dl className="dl">
            <Pair label="Dudosas aprobadas en revisión" value={l.uncertainApproved} />
            <Pair label="Dudosas rechazadas en revisión" value={l.uncertainRejected} />
            <Pair
              label="Aceptadas por el Juez y aprobadas (revisión obligatoria)"
              value={l.acceptedApproved}
            />
            <Pair
              label="Aceptadas por el Juez y rechazadas (revisión obligatoria)"
              value={l.acceptedRejected}
            />
            <Pair label="Cuarentenas del Juez restauradas" value={l.restoredFromJudge} />
            <Pair
              label="Otras restauraciones (sanitización / líder técnico)"
              value={d.judge.restoredOther.pipeline + d.judge.restoredOther.humanReview}
            />
          </dl>
          <p className="muted small insights__gap">
            Las otras restauraciones son correcciones humanas, pero no cuentan para los indicadores
            del Juez: esas unidades no las retuvo el Juez.
          </p>
        </section>
      </div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="kpi__num">{value}</dd>
    </>
  );
}

function Indicator({
  title,
  rate,
  definition,
}: {
  title: string;
  rate: RateDto;
  definition: string;
}) {
  return (
    <div className="kpi">
      <h3 className="section__label">{title}</h3>
      <p className="kpi__value">{formatPercent(rate.rate)}</p>
      <p className="muted small">{rateCountText(rate)}</p>
      <p className="kpi__definition">{definition}</p>
    </div>
  );
}
