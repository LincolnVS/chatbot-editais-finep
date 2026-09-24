import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { DocumentSummary, IngestionJob } from '@editais/shared';

/** Acompanha a ingestão dos documentos ainda não prontos via SSE (`GET /api/documents/:id/events`, evento `job`). */
export function useDocumentJobs(workspaceId: string, documents: DocumentSummary[] | undefined): Record<string, IngestionJob> {
  const qc = useQueryClient();
  const [jobs, setJobs] = useState<Record<string, IngestionJob>>({});
  const sources = useRef(new Map<string, EventSource>());

  const pendingIds = (documents ?? []).filter((d) => d.status === 'uploaded' || d.status === 'processing').map((d) => d.id).join(',');

  useEffect(() => {
    const ids = pendingIds ? pendingIds.split(',') : [];
    const map = sources.current;
    for (const id of ids) {
      if (map.has(id)) continue;
      const es = new EventSource(`/api/documents/${id}/events`);
      map.set(id, es);
      es.addEventListener('job', (ev) => {
        const job = JSON.parse((ev as MessageEvent<string>).data) as IngestionJob;
        setJobs((prev) => ({ ...prev, [id]: job }));
        if (job.status === 'done' || job.status === 'failed') {
          es.close();
          map.delete(id);
          void qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
          void qc.invalidateQueries({ queryKey: ['chunks'] });
        }
      });
      es.onerror = () => {
        // conexão caiu (API reiniciou?): fecha e deixa o polling do react-query recuperar o estado
        es.close();
        map.delete(id);
        void qc.invalidateQueries({ queryKey: ['workspace', workspaceId] });
      };
    }
    for (const [id, es] of map) {
      if (!ids.includes(id)) {
        es.close();
        map.delete(id);
      }
    }
  }, [pendingIds, qc, workspaceId]);

  useEffect(() => {
    const map = sources.current;
    return () => {
      for (const es of map.values()) es.close();
      map.clear();
    };
  }, []);

  return jobs;
}
