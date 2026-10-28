import type { AiChangeset, AiStatus, AiUsage, PlanStep } from '@galley/shared';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCost, hunkDiff, hunksByFile } from '../lib/ai.js';
import { type AiMessage, useAi } from '../stores/ai.js';
import { currentSelection, useEditor } from '../stores/editor.js';
import { Button, ErrorAlert } from './ui.js';

const DIFF_STYLE = {
  context: 'text-slate-600',
  removed: 'bg-red-50 text-red-900 line-through decoration-red-400',
  added: 'bg-emerald-50 text-emerald-900',
} as const;

const DIFF_SIGN = { context: ' ', removed: '-', added: '+' } as const;

/** Translated message of a stream or API error code. */
function useErrorText() {
  const { t } = useTranslation();
  return (code: string) =>
    // Codes come from the API contract; an unknown one falls back to the generic message.
    t(`errors.${code}` as 'errors.INTERNAL_ERROR', { defaultValue: t('errors.INTERNAL_ERROR') });
}

function UsageLine({ usage }: { usage: AiUsage }) {
  const { t, i18n } = useTranslation();
  return (
    <p className="text-[11px] text-slate-500" data-testid="ai-usage">
      {t('ai.usage.line', {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cached: usage.cachedInputTokens,
      })}
      {' · '}
      {usage.costMicros === null || usage.currency === null
        ? t('ai.usage.noPrice')
        : formatCost(usage.costMicros, usage.currency, i18n.language)}
    </p>
  );
}

/** A proposal of the assistant: its differential, file by file, with the decisions. */
export function ChangesetCard({
  changeset,
  canEdit,
}: {
  changeset: AiChangeset;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const decide = useAi((state) => state.decide);
  const [pending, setPending] = useState(false);
  const run = (decision: 'apply' | 'reject', ids: string[]) => {
    setPending(true);
    void decide(changeset.id, decision, ids).finally(() => {
      setPending(false);
    });
  };
  const open = changeset.hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.id);
  const actions = (ids: string[], scope: 'hunk' | 'file' | 'all') =>
    canEdit &&
    ids.length > 0 && (
      <span className="flex gap-1">
        <Button
          variant="primary"
          className="px-2 py-0.5 text-xs"
          disabled={pending}
          onClick={() => {
            run('apply', ids);
          }}
        >
          {t(`ai.accept${scope === 'hunk' ? '' : scope === 'file' ? 'File' : 'All'}`)}
        </Button>
        <Button
          className="px-2 py-0.5 text-xs"
          disabled={pending}
          onClick={() => {
            run('reject', ids);
          }}
        >
          {t(`ai.reject${scope === 'hunk' ? '' : scope === 'file' ? 'File' : 'All'}`)}
        </Button>
      </span>
    );
  return (
    <div
      className="space-y-2 rounded-md border border-slate-200 p-2"
      data-testid="ai-changeset"
      aria-label={t('ai.proposal')}
      role="group"
    >
      {hunksByFile(changeset.hunks).map(([path, hunks]) => (
        <div key={path} className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="mr-auto truncate font-mono text-xs font-medium">
              {path}
              {hunks.some((hunk) => hunk.fileId === null) && ` (${t('ai.newFile')})`}
            </span>
            {hunksByFile(changeset.hunks).length > 1 &&
              actions(
                hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.id),
                'file',
              )}
          </div>
          {hunks.map((hunk) => (
            <div
              key={hunk.id}
              data-testid="ai-hunk"
              data-status={hunk.status}
              className="space-y-1"
            >
              <pre className="max-h-60 overflow-auto rounded bg-slate-50 font-mono text-[11px] leading-snug">
                {hunkDiff(hunk).map((line, index) => (
                  <span
                    // Lines of a diff have no identity; the diff is fixed for a hunk.
                    key={index}
                    className={`block px-1 whitespace-pre-wrap ${DIFF_STYLE[line.kind]}`}
                  >
                    {DIFF_SIGN[line.kind]} {line.text}
                  </span>
                ))}
              </pre>
              <div className="flex items-center gap-2 text-xs">
                {hunk.status !== 'pending' && (
                  <span
                    className={
                      hunk.status === 'conflict' ? 'font-medium text-red-800' : 'text-slate-600'
                    }
                  >
                    {t(`ai.status.${hunk.status}`)}
                  </span>
                )}
                <span className="mr-auto" />
                {hunk.status === 'pending' && actions([hunk.id], 'hunk')}
              </div>
            </div>
          ))}
        </div>
      ))}
      {changeset.hunks.length > 1 && (
        <div className="flex justify-end border-t border-slate-100 pt-1">
          {actions(open, 'all')}
        </div>
      )}
    </div>
  );
}

const PLAN_MARK = { pending: '○', active: '◐', done: '✓' } as const;

/** The agent's plan, as it last showed it. */
function PlanList({ steps }: { steps: PlanStep[] }) {
  const { t } = useTranslation();
  return (
    <ol
      className="space-y-0.5 rounded-md bg-slate-50 px-2 py-1 text-xs"
      aria-label={t('ai.agent.plan')}
    >
      {steps.map((step, index) => (
        <li
          // A plan is resent whole; its steps have no identity beyond their place.
          key={index}
          data-testid="ai-plan-step"
          data-status={step.status}
          className={
            step.status === 'done'
              ? 'text-slate-500'
              : step.status === 'active'
                ? 'font-medium'
                : ''
          }
        >
          <span aria-hidden="true">{PLAN_MARK[step.status]} </span>
          {step.title}
          <span className="sr-only"> ({t(`ai.planStatus.${step.status}`)})</span>
        </li>
      ))}
    </ol>
  );
}

function AssistantMessage({ message, canEdit }: { message: AiMessage; canEdit: boolean }) {
  const { t } = useTranslation();
  const changesets = useAi((state) => state.changesets);
  const errorText = useErrorText();
  return (
    <li className="space-y-1 text-sm" data-testid="ai-answer">
      {message.plan !== null && message.plan.length > 0 && <PlanList steps={message.plan} />}
      {message.tools.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-slate-600">
          {message.tools.map((tool, index) => (
            // Tool lines only grow; their order identifies them.
            <li key={index} data-testid="ai-tool" data-status={tool.status}>
              {t(`ai.tools.${tool.name}`)}
              {tool.detail !== undefined && tool.detail !== '' && (
                <span className="font-mono"> {tool.detail}</span>
              )}
              {tool.status === 'running'
                ? ' …'
                : tool.status === 'error'
                  ? ` (${t('ai.toolFailed')})`
                  : ''}
            </li>
          ))}
        </ul>
      )}
      {/* An inline edit's answer is its code, shown as the proposal below. */}
      {message.text !== '' && !(message.mode === 'inline' && message.changesetIds.length > 0) && (
        <p className="break-words whitespace-pre-wrap">{message.text}</p>
      )}
      {!message.done && message.text === '' && message.tools.length === 0 && (
        <p className="text-slate-500">{t('ai.thinking')}</p>
      )}
      {message.changesetIds.map((id) => {
        const changeset = changesets[id];
        return changeset && <ChangesetCard key={id} changeset={changeset} canEdit={canEdit} />;
      })}
      {message.error !== null && (
        <p role="alert" className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-900">
          {errorText(message.error)}
        </p>
      )}
      {message.usage !== null && <UsageLine usage={message.usage} />}
    </li>
  );
}

function Unavailable({ status }: { status: AiStatus }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 text-sm text-slate-700" data-testid="ai-unavailable">
      <p>{t(`ai.unavailable.${status.reason ?? 'not-configured'}`)}</p>
      {status.reason === 'not-configured' && (
        <Link to="/account" className="text-accent underline">
          {t('ai.configure')}
        </Link>
      )}
    </div>
  );
}

function InlinePrompt({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const inline = useAi((state) => state.inline);
  const { send, cancelInline, busy } = useAi();
  const [instruction, setInstruction] = useState('');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inline !== null) field.current?.focus();
  }, [inline]);
  if (inline === null || !canEdit) return null;
  return (
    <form
      className="space-y-1 rounded-md border border-accent/40 bg-slate-50 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        void send({
          mode: 'inline',
          text: instruction,
          context: { fileId: inline.fileId, selection: { from: inline.from, to: inline.to } },
        });
        setInstruction('');
      }}
    >
      <p className="text-xs font-medium">{t('ai.inline.title')}</p>
      <pre className="max-h-24 overflow-auto rounded bg-white px-1 font-mono text-[11px] whitespace-pre-wrap text-slate-700">
        {inline.quote}
      </pre>
      <input
        ref={field}
        aria-label={t('ai.inline.instruction')}
        placeholder={t('ai.inline.instruction')}
        value={instruction}
        maxLength={4000}
        onChange={(event) => {
          setInstruction(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancelInline();
        }}
        className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
      />
      <div className="flex gap-1">
        <Button type="submit" variant="primary" disabled={instruction.trim() === '' || busy}>
          {t('ai.inline.submit')}
        </Button>
        <Button variant="ghost" onClick={cancelInline}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The open file, cursor and selection, sent with a question as its context. */
function editorContext() {
  const { activeId } = useEditor.getState();
  const selection = currentSelection();
  if (activeId === null) return {};
  if (selection?.fileId !== activeId) return { fileId: activeId };
  return {
    fileId: activeId,
    cursor: selection.head,
    ...(selection.from === selection.to
      ? {}
      : { selection: { from: selection.from, to: selection.to } }),
  };
}

/**
 * The assistant of a project (SPEC §3.8): a conversation that knows the
 * project, whose proposed changes are applied only once accepted.
 */
export function AiPanel({ status, canEdit }: { status: AiStatus; canEdit: boolean }) {
  const { t } = useTranslation();
  const { messages, busy, send, stop, clear, decisionError } = useAi();
  const [text, setText] = useState('');
  const [agent, setAgent] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [last?.id, last?.text.length, last?.changesetIds.length, last?.plan]);

  if (!status.available) return <Unavailable status={status} />;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <p className="text-[11px] text-slate-500">
        {t('ai.model', { provider: status.provider ?? '', model: status.model ?? '' })}
      </p>
      <InlinePrompt canEdit={canEdit} />
      <div className="min-h-0 flex-1 overflow-auto" aria-live="polite">
        {messages.length === 0 && <p className="text-sm text-slate-600">{t('ai.empty')}</p>}
        <ul className="space-y-3">
          {messages.map((message) =>
            message.role === 'user' ? (
              <li
                key={message.id}
                className="rounded-md bg-slate-100 px-2 py-1 text-sm break-words whitespace-pre-wrap"
                data-testid="ai-question"
              >
                {message.text}
              </li>
            ) : (
              <AssistantMessage key={message.id} message={message} canEdit={canEdit} />
            ),
          )}
        </ul>
        <ErrorAlert error={decisionError} />
        <div ref={end} />
      </div>
      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          void send({ mode: agent && canEdit ? 'agent' : 'chat', text, context: editorContext() });
          setText('');
        }}
      >
        <textarea
          aria-label={t('ai.message')}
          placeholder={t('ai.message')}
          value={text}
          rows={3}
          maxLength={20_000}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && text.trim() !== '' && !busy) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
        <div className="flex gap-1">
          {busy ? (
            <Button onClick={stop}>{t('ai.stop')}</Button>
          ) : (
            <Button type="submit" variant="primary" disabled={text.trim() === ''}>
              {t('ai.send')}
            </Button>
          )}
          <Button variant="ghost" disabled={busy || messages.length === 0} onClick={clear}>
            {t('ai.newConversation')}
          </Button>
        </div>
        {canEdit && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={agent}
              disabled={busy}
              onChange={(event) => {
                setAgent(event.currentTarget.checked);
              }}
            />
            {t('ai.agent.toggle')}
          </label>
        )}
        <p className="text-[11px] text-slate-500">
          {agent && canEdit ? t('ai.agent.hint') : t('ai.hint')}
        </p>
      </form>
    </div>
  );
}
