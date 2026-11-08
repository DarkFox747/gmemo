/**
 * "Buscar como agente": runs the same search as an agent's recall (one server
 * code path) and shows each result's fused score and its lexical and semantic
 * ranks. Submit-only, so each audit row and embedding call matches one
 * deliberate query. The repo list comes from the admin summary; if it fails,
 * the selector is disabled with a visible note and search still works.
 */

import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { MEMORY_TYPES } from '../api/types';
import type { MemoryType, SearchResponseDto } from '../api/types';
import { TypeChip } from '../components/Chip';
import { Empty, ErrorMessage, Loading, NoAccess } from '../components/StateViews';
import { buildHash } from '../lib/hashRoute';
import { SEARCH, typeLabel } from '../lib/labels';
import { useAsync } from '../lib/useAsync';
import type { ScreenProps } from './types';

const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const DEFAULT_LIMIT = 5;

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: SearchResponseDto }
  | { status: 'error'; error: unknown };

function Header() {
  return (
    <>
      <h1 className="screen__title" tabIndex={-1}>
        {SEARCH.title}
      </h1>
      <p className="screen__subtitle">{SEARCH.subtitle}</p>
    </>
  );
}

export function SearchScreen(props: ScreenProps) {
  if (props.role !== 'project_admin') {
    return (
      <>
        <Header />
        <NoAccess />
      </>
    );
  }
  return <Search {...props} />;
}

function Search({ api, projectId }: ScreenProps) {
  const id = useId();
  const summary = useAsync(() => api.getAdminSummary(projectId), [api, projectId]);
  const repos = summary.status === 'ready' ? summary.data.repos : [];
  const repoLabel = (repoId: string | null): string => {
    if (repoId === null) return SEARCH.none;
    const r = repos.find((x) => x.id === repoId);
    return r ? (r.slug ?? r.remoteUrl) : SEARCH.none;
  };

  const [query, setQuery] = useState('');
  const [types, setTypes] = useState<MemoryType[]>([]);
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [repoId, setRepoId] = useState('');
  const [blank, setBlank] = useState(false);
  const [result, setResult] = useState<SearchState>({ status: 'idle' });
  // Only the newest search may write the result.
  const seq = useRef(0);

  function toggleType(t: MemoryType): void {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    const q = query.trim();
    if (q.length === 0) {
      setBlank(true);
      return;
    }
    setBlank(false);
    const mine = ++seq.current;
    setResult({ status: 'loading' });
    api
      .search(projectId, {
        q,
        types,
        limit,
        repoId: repoId === '' ? undefined : repoId,
      })
      .then(
        (data) => {
          if (mine === seq.current) setResult({ status: 'ready', data });
        },
        (error: unknown) => {
          console.error('[search] request failed', error);
          if (mine === seq.current) setResult({ status: 'error', error });
        },
      );
  }

  return (
    <>
      <Header />
      <div className="card search__intro">
        <p>{SEARCH.explanation}</p>
        <p className="muted small">{SEARCH.scoreFormula}</p>
        <p className="muted small">{SEARCH.repoHint}</p>
      </div>
      <form className="card search__form" onSubmit={submit} role="search">
        <div className="field">
          <label className="field__label" htmlFor={`${id}-q`}>
            {SEARCH.query}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            className="input"
            maxLength={200}
            required
            value={query}
            aria-describedby={blank ? `${id}-q-hint` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setBlank(false);
            }}
          />
          {blank && (
            <p id={`${id}-q-hint`} className="field__hint small" role="status">
              {SEARCH.blankQuery}
            </p>
          )}
        </div>
        <div className="field">
          <p className="field__label" id={`${id}-types`}>
            {SEARCH.types}
          </p>
          <div className="filters search__types" role="group" aria-labelledby={`${id}-types`}>
            {MEMORY_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className="pill"
                aria-pressed={types.includes(t)}
                onClick={() => toggleType(t)}
              >
                {typeLabel(t)}
              </button>
            ))}
          </div>
        </div>
        <div className="search__row">
          <div className="field">
            <label className="field__label" htmlFor={`${id}-limit`}>
              {SEARCH.limit}
            </label>
            <select
              id={`${id}-limit`}
              className="select"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-repo`}>
              {SEARCH.repo}
            </label>
            <select
              id={`${id}-repo`}
              className="select"
              value={repoId}
              disabled={summary.status !== 'ready'}
              aria-describedby={summary.status === 'error' ? `${id}-repo-note` : undefined}
              onChange={(e) => setRepoId(e.target.value)}
            >
              <option value="">{SEARCH.repoNone}</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.slug ?? r.remoteUrl}
                </option>
              ))}
            </select>
            {summary.status === 'error' && (
              <p id={`${id}-repo-note`} className="field__hint small">
                {SEARCH.repoUnavailable}
              </p>
            )}
          </div>
          <button type="submit" className="btn btn--primary" disabled={result.status === 'loading'}>
            {result.status === 'loading' ? SEARCH.searching : SEARCH.submit}
          </button>
        </div>
      </form>

      <div className="card card--table" data-state={result.status}>
        {result.status === 'idle' && <Empty text={SEARCH.prompt} />}
        {result.status === 'loading' && <Loading />}
        {result.status === 'error' && <ErrorMessage error={result.error} />}
        {result.status === 'ready' && (
          <>
            {result.data.semantic === 'unavailable' && (
              <p className="banner banner--warning" role="status">
                {SEARCH.semanticUnavailable}
              </p>
            )}
            {result.data.items.length === 0 ? (
              <Empty text={SEARCH.empty} />
            ) : (
              <>
                <table className="table search__table">
                  <caption className="visually-hidden">{SEARCH.caption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{SEARCH.cols.position}</th>
                      <th scope="col">{SEARCH.cols.title}</th>
                      <th scope="col">{SEARCH.cols.type}</th>
                      <th scope="col">{SEARCH.cols.repo}</th>
                      <th scope="col" className="num">
                        {SEARCH.cols.score}
                      </th>
                      <th scope="col" className="num">
                        {SEARCH.cols.lexical}
                      </th>
                      <th scope="col" className="num">
                        {SEARCH.cols.semantic}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.data.items.map((it) => (
                      <tr key={it.id}>
                        <td className="num">{it.position}</td>
                        <td>
                          <a
                            className="cell--title"
                            href={buildHash({ name: 'memoryDetail', memoryId: it.id })}
                          >
                            {it.title}
                          </a>
                          <p className="muted small">{it.summary}</p>
                        </td>
                        <td>
                          <TypeChip type={it.type} />
                        </td>
                        <td className="mono">{repoLabel(it.repoId)}</td>
                        <td className="num mono">{it.score.toFixed(4)}</td>
                        <td className="num">{it.lexicalRank ?? SEARCH.none}</td>
                        <td className="num">{it.semanticRank ?? SEARCH.none}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="table__note small">
                  {SEARCH.total(result.data.items.length, result.data.totalCandidates)}
                </p>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
