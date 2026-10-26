import type { TreeNode } from '@galley/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fileContentUrl } from '../lib/api.js';
import { previewKind } from '../lib/tree.js';

function TextPreview({ url }: { url: string }) {
  const { t } = useTranslation();
  const content = useQuery({
    queryKey: ['content', url],
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { signal, credentials: 'same-origin' });
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    },
  });
  if (content.isLoading) return <p className="text-slate-600">{t('common.loading')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-600">{t('project.preview.readOnly')}</p>
      <pre
        data-testid="text-preview"
        className="max-h-[70vh] overflow-auto rounded-md bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap"
      >
        {content.data}
      </pre>
    </div>
  );
}

/** Read-only preview of the selected file (J1); the editor replaces it for text in J2. */
export function FilePreview({
  projectId,
  node,
}: {
  projectId: string;
  node: TreeNode | undefined;
}) {
  const { t } = useTranslation();
  if (!node) return <p className="text-slate-600">{t('project.preview.empty')}</p>;
  if (node.kind === 'folder')
    return (
      <p className="text-slate-600">
        {t('project.preview.folder')} : {node.name}
      </p>
    );
  const url = fileContentUrl(projectId, node.id);
  const download = (
    <a href={url} download={node.name} className="text-sm text-accent underline">
      {t('project.preview.download')}
    </a>
  );
  switch (previewKind(node)) {
    case 'text':
      return <TextPreview key={url} url={`${url}?v=${node.updatedAt}`} />;
    case 'image':
      return (
        <figure className="space-y-2">
          <img
            src={`${url}?v=${node.updatedAt}`}
            alt={node.name}
            className="max-h-[70vh] max-w-full rounded border border-slate-200"
          />
          <figcaption>{download}</figcaption>
        </figure>
      );
    case 'pdf':
      return (
        <p className="space-x-4">
          <a href={url} target="_blank" rel="noopener" className="text-accent underline">
            {t('project.preview.openPdf')}
          </a>
          {download}
        </p>
      );
    default:
      return (
        <p className="space-x-4 text-slate-600">
          <span>{t('project.preview.none')}</span>
          {download}
        </p>
      );
  }
}
