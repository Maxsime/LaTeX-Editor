import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMessages, useSendMessage } from '../lib/review.js';
import { Button, ErrorAlert } from './ui.js';

/** The project's chat: every member reads and writes; new messages arrive live. */
export function ChatPanel({ projectId }: { projectId: string }) {
  const { t, i18n } = useTranslation();
  const messages = useMessages(projectId);
  const send = useSendMessage(projectId);
  const [body, setBody] = useState('');
  const end = useRef<HTMLDivElement>(null);
  // Pages are newest first; each page is oldest first.
  const list = [...(messages.data?.pages ?? [])].reverse().flatMap((page) => page.messages);
  const last = list.at(-1)?.id;

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [last]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto" aria-live="polite">
        {messages.hasNextPage && (
          <Button
            disabled={messages.isFetchingNextPage}
            onClick={() => {
              void messages.fetchNextPage();
            }}
          >
            {t('chat.older')}
          </Button>
        )}
        <ErrorAlert error={messages.error} />
        {list.length === 0 && messages.isSuccess && (
          <p className="text-sm text-slate-600">{t('chat.empty')}</p>
        )}
        <ul className="space-y-2">
          {list.map((message) => (
            <li key={message.id} data-testid="chat-message" className="text-sm">
              <p className="text-xs text-slate-600">
                <span className="font-medium text-slate-800">
                  {message.author?.displayName ?? t('review.deletedUser')}
                </span>{' '}
                · {new Date(message.createdAt).toLocaleString(i18n.language)}
              </p>
              <p className="whitespace-pre-wrap break-words">{message.body}</p>
            </li>
          ))}
        </ul>
        <div ref={end} />
      </div>
      <form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          send.mutate(body, {
            onSuccess: () => {
              setBody('');
            },
          });
        }}
      >
        <textarea
          aria-label={t('chat.message')}
          placeholder={t('chat.message')}
          value={body}
          rows={2}
          maxLength={4000}
          onChange={(event) => {
            setBody(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter starts a new line, as in most chats.
            if (event.key === 'Enter' && !event.shiftKey && body.trim() !== '') {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
        <ErrorAlert error={send.error} />
        <Button type="submit" variant="primary" disabled={body.trim() === '' || send.isPending}>
          {t('chat.send')}
        </Button>
      </form>
    </div>
  );
}
