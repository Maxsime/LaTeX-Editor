import {
  acceptAll,
  acceptSuggestion,
  rejectAll,
  rejectSuggestion,
  resolveRanges,
  type ResolvedRange,
} from '@galley/review';
import { type CommentThread, hasRole, type ProjectRole } from '@galley/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OpenDocument } from '../editor/connection.js';
import { anchorComment, REVIEW_ORIGIN } from '../editor/review.js';
import { lineColumnAt, useReadMentions, useThreadMutations, useThreads } from '../lib/review.js';
import { useSession } from '../lib/session.js';
import { useMembers } from '../lib/sharing.js';
import { useEditor } from '../stores/editor.js';
import { useReview } from '../stores/review.js';
import { Button, ErrorAlert } from './ui.js';

interface ReviewPanelProps {
  projectId: string;
  role: ProjectRole;
  /** Name of each file, for threads on files other than the open one. */
  names: ReadonlyMap<string, string>;
}

const textareaClass = 'w-full rounded-md border border-slate-300 px-2 py-1 text-sm';

/** The open document of a file, followed through reloads and reconnections. */
function useOpenDocument(fileId: string | null): OpenDocument | undefined {
  const connection = useReview((state) => state.connection);
  // Read only to re-render when the document is replaced or comes online.
  useReview((state) => (fileId === null ? 0 : (state.reloads[fileId] ?? 0)));
  useEditor((state) => (fileId === null ? undefined : state.status[fileId]));
  return fileId === null ? undefined : connection?.document(fileId);
}

/** Entries of a document with their positions, recomputed after each of its transactions. */
function useRanges(document: OpenDocument | undefined): readonly ResolvedRange[] {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (document === undefined) return;
    const bump = () => {
      setVersion((value) => value + 1);
    };
    document.doc.on('afterTransaction', bump);
    return () => {
      document.doc.off('afterTransaction', bump);
    };
  }, [document]);
  return useMemo(
    () => {
      if (document === undefined) return [];
      return resolveRanges(document.text, document.ranges);
    },
    // `version` stands for the document's content, which React cannot see.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [document, version],
  );
}

/** Moves the editor to a place of an open document. */
function reveal(document: OpenDocument, from: number, to: number): void {
  const { line, column } = lineColumnAt(document.text.toJSON(), from);
  useEditor.getState().revealAt({
    fileId: document.fileId,
    line,
    column,
    length: Math.max(0, to - from),
  });
}

function NewComment({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const pending = useReview((state) => state.pending);
  const document = useOpenDocument(pending?.fileId ?? null);
  const { user } = useSession();
  const { create } = useThreadMutations(projectId);
  const [body, setBody] = useState('');
  if (pending === null) return null;
  const cancel = () => {
    useReview.getState().setPending(null);
    setBody('');
  };
  return (
    <form
      className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate(
          { fileId: pending.fileId, quote: pending.quote.slice(0, 500), body },
          {
            onSuccess: (thread) => {
              if (document !== undefined && user) {
                anchorComment(
                  document.text,
                  document.ranges,
                  thread.id,
                  user.id,
                  pending.from,
                  pending.to,
                );
              }
              cancel();
            },
          },
        );
      }}
    >
      <blockquote className="line-clamp-3 border-l-2 border-amber-400 pl-2 text-xs text-slate-700">
        {pending.quote}
      </blockquote>
      <label className="block text-sm">
        <span className="sr-only">{t('review.comment.body')}</span>
        <textarea
          // The user just asked to comment: the field is where they type next.
          autoFocus
          value={body}
          rows={3}
          maxLength={4000}
          placeholder={t('review.comment.placeholder')}
          onChange={(event) => {
            setBody(event.currentTarget.value);
          }}
          className={textareaClass}
        />
      </label>
      <ErrorAlert error={create.error} />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={body.trim() === '' || create.isPending}>
          {t('review.comment.submit')}
        </Button>
        <Button type="button" onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

function Suggestions({ role, nameOf }: { role: ProjectRole; nameOf: (userId: string) => string }) {
  const { t, i18n } = useTranslation();
  const activeId = useEditor((state) => state.activeId);
  const document = useOpenDocument(activeId);
  const ranges = useRanges(document);
  const suggestions = ranges.filter((range) => range.kind !== 'comment');
  const canDecide = hasRole(role, 'editor');
  if (document === undefined) return null;
  const run = (operation: () => void) => {
    document.doc.transact(operation, REVIEW_ORIGIN);
  };
  return (
    <section aria-labelledby="review-suggestions" className="space-y-2">
      <h3 id="review-suggestions" className="text-sm font-semibold">
        {t('review.suggestions.title', { count: suggestions.length })}
      </h3>
      {canDecide && suggestions.length > 0 && (
        <div className="flex gap-2">
          <Button
            onClick={() => {
              run(() => {
                acceptAll(document.ranges);
              });
            }}
          >
            {t('review.suggestions.acceptAll')}
          </Button>
          <Button
            onClick={() => {
              run(() => {
                rejectAll(document.text, document.ranges);
              });
            }}
          >
            {t('review.suggestions.rejectAll')}
          </Button>
        </div>
      )}
      <ul className="space-y-1">
        {suggestions.map((range) => {
          const from = range.kind === 'delete' ? range.pos : range.from;
          const to = range.kind === 'delete' ? range.pos : range.to;
          const excerpt =
            range.kind === 'delete'
              ? range.text
              : document.text.toJSON().slice(range.from, range.to);
          return (
            <li
              key={range.id}
              data-testid="suggestion"
              data-kind={range.kind}
              className="rounded-md border border-slate-200 p-2 text-sm"
            >
              <button
                type="button"
                className="block w-full text-left"
                onClick={() => {
                  reveal(document, from, to);
                }}
              >
                <span className="text-xs text-slate-600">
                  {t(`review.suggestions.${range.kind}`, { name: nameOf(range.author) })} ·{' '}
                  {new Date(range.at).toLocaleString(i18n.language)}
                </span>
                <span
                  className={`mt-1 block truncate font-mono text-xs ${range.kind === 'delete' ? 'text-red-700 line-through' : 'text-emerald-800'}`}
                >
                  {excerpt}
                </span>
              </button>
              {canDecide && (
                <div className="mt-1 flex gap-2">
                  <Button
                    onClick={() => {
                      run(() => {
                        acceptSuggestion(document.ranges, range.id);
                      });
                    }}
                  >
                    {t('review.suggestions.accept')}
                  </Button>
                  <Button
                    onClick={() => {
                      run(() => {
                        rejectSuggestion(document.text, document.ranges, range.id);
                      });
                    }}
                  >
                    {t('review.suggestions.reject')}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Thread({
  projectId,
  thread,
  role,
  fileName,
}: {
  projectId: string;
  thread: CommentThread;
  role: ProjectRole;
  fileName: string | null;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useSession();
  const mutations = useThreadMutations(projectId);
  const readMentions = useReadMentions();
  const document = useOpenDocument(thread.fileId);
  const ranges = useRanges(document);
  const [reply, setReply] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const anchor = ranges.find((range) => range.id === thread.id);
  const canComment = hasRole(role, 'reviewer');
  const canManage = hasRole(role, 'editor') || (canComment && thread.author?.id === user?.id);
  const error =
    mutations.reply.error ??
    mutations.edit.error ??
    mutations.removeComment.error ??
    mutations.resolve.error ??
    mutations.remove.error;

  const open = () => {
    readMentions.mutate(thread.id);
    if (thread.fileId === null) return;
    useEditor.getState().openTab(thread.fileId);
    if (document !== undefined && anchor?.kind === 'comment') {
      reveal(document, anchor.from, anchor.to);
    }
  };

  return (
    <li
      data-testid="thread"
      className={`space-y-2 rounded-md border p-2 text-sm ${thread.resolvedAt === null ? 'border-amber-300' : 'border-slate-200 opacity-75'}`}
    >
      <button type="button" className="block w-full text-left" onClick={open}>
        <span className="text-xs text-slate-600">
          {fileName ?? t('review.threads.noFile')}
          {document !== undefined && anchor === undefined && ` · ${t('review.threads.lost')}`}
        </span>
        <blockquote className="line-clamp-2 border-l-2 border-amber-400 pl-2 text-xs">
          {thread.quote}
        </blockquote>
      </button>
      <ul className="space-y-1">
        {thread.comments.map((comment) => (
          <li key={comment.id}>
            <p className="text-xs text-slate-600">
              {comment.author?.displayName ?? t('review.deletedUser')} ·{' '}
              {new Date(comment.createdAt).toLocaleString(i18n.language)}
              {comment.editedAt !== null && ` · ${t('review.comment.edited')}`}
            </p>
            {editing?.id === comment.id ? (
              <form
                className="space-y-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  mutations.edit.mutate(
                    { threadId: thread.id, commentId: comment.id, body: editing.body },
                    {
                      onSuccess: () => {
                        setEditing(null);
                      },
                    },
                  );
                }}
              >
                <textarea
                  aria-label={t('review.comment.body')}
                  value={editing.body}
                  rows={2}
                  maxLength={4000}
                  onChange={(event) => {
                    setEditing({ id: comment.id, body: event.currentTarget.value });
                  }}
                  className={textareaClass}
                />
                <div className="flex gap-2">
                  <Button type="submit" variant="primary">
                    {t('common.save')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      setEditing(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap break-words">
                {comment.body ?? <em className="text-slate-500">{t('review.comment.deleted')}</em>}
              </p>
            )}
            {comment.body !== null &&
              user !== undefined &&
              user !== null &&
              comment.author?.id === user.id &&
              canComment &&
              editing === null && (
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      setEditing({ id: comment.id, body: comment.body ?? '' });
                    }}
                  >
                    {t('review.comment.edit')}
                  </button>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => {
                      mutations.removeComment.mutate({
                        threadId: thread.id,
                        commentId: comment.id,
                      });
                    }}
                  >
                    {t('review.comment.delete')}
                  </button>
                </div>
              )}
          </li>
        ))}
      </ul>
      {canComment && thread.resolvedAt === null && (
        <form
          className="space-y-1"
          onSubmit={(event) => {
            event.preventDefault();
            mutations.reply.mutate(
              { threadId: thread.id, body: reply },
              {
                onSuccess: () => {
                  setReply('');
                },
              },
            );
          }}
        >
          <textarea
            aria-label={t('review.threads.reply')}
            placeholder={t('review.threads.reply')}
            value={reply}
            rows={2}
            maxLength={4000}
            onChange={(event) => {
              setReply(event.currentTarget.value);
            }}
            className={textareaClass}
          />
          <Button type="submit" disabled={reply.trim() === ''}>
            {t('review.threads.send')}
          </Button>
        </form>
      )}
      <ErrorAlert error={error} />
      {canManage && (
        <div className="flex gap-2">
          <Button
            onClick={() => {
              mutations.resolve.mutate({
                threadId: thread.id,
                resolved: thread.resolvedAt === null,
              });
            }}
          >
            {thread.resolvedAt === null ? t('review.threads.resolve') : t('review.threads.reopen')}
          </Button>
          <Button
            onClick={() => {
              mutations.remove.mutate(thread.id, {
                onSuccess: () => {
                  // The anchor goes with the thread; a reviewer may remove their own only.
                  if (document !== undefined) {
                    document.doc.transact(() => {
                      document.ranges.delete(thread.id);
                    }, REVIEW_ORIGIN);
                  }
                },
              });
            }}
          >
            {t('review.threads.delete')}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Suggestions of the open file, and the project's comment threads. Select
 * text and press Ctrl+Alt+M (or ⌘⌥M) in the editor to start a thread.
 */
export default function ReviewPanel({ projectId, role, names }: ReviewPanelProps) {
  const { t } = useTranslation();
  const threads = useThreads(projectId);
  const members = useMembers(projectId);
  const [showResolved, setShowResolved] = useState(false);
  const nameOf = (userId: string) =>
    members.data?.find((member) => member.userId === userId)?.displayName ??
    t('review.deletedUser');
  const shown = (threads.data ?? []).filter((thread) => showResolved || thread.resolvedAt === null);
  return (
    <div className="space-y-4">
      <NewComment projectId={projectId} />
      <Suggestions role={role} nameOf={nameOf} />
      <section aria-labelledby="review-threads" className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 id="review-threads" className="text-sm font-semibold">
            {t('review.threads.title')}
          </h3>
          <label className="ml-auto flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(event) => {
                setShowResolved(event.currentTarget.checked);
              }}
            />
            {t('review.threads.showResolved')}
          </label>
        </div>
        {hasRole(role, 'reviewer') && (
          <p className="text-xs text-slate-600">{t('review.threads.hint')}</p>
        )}
        <ErrorAlert error={threads.error} />
        {shown.length === 0 && threads.isSuccess && (
          <p className="text-sm text-slate-600">{t('review.threads.empty')}</p>
        )}
        <ul className="space-y-2">
          {shown.map((thread) => (
            <Thread
              key={thread.id}
              projectId={projectId}
              thread={thread}
              role={role}
              fileName={thread.fileId === null ? null : (names.get(thread.fileId) ?? null)}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}
