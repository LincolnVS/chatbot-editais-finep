import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { WorkspacesPage } from '@/pages/WorkspacesPage';
import { WorkspacePage } from '@/pages/WorkspacePage';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { ResultsPage } from '@/pages/ResultsPage';
import ResultPage from '@/pages/ResultPage';
import { DatasetPage } from '@/pages/DatasetPage';
// react-pdf (pdf.js) só carrega ao abrir um documento
const DocumentPage = lazy(() => import('@/pages/DocumentPage').then((m) => ({ default: m.DocumentPage })));

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<WorkspacesPage />} />
        <Route path="w/:workspaceId" element={<WorkspacePage />} />
        <Route path="arquitetura" element={<ArchitecturePage />} />
        <Route path="dataset" element={<DatasetPage />} />
        <Route path="resultados" element={<ResultPage />} />
        <Route path="exploracao" element={<ResultsPage />} />
        <Route path="w/:workspaceId/doc/:documentId" element={<Suspense fallback={<p className="p-6 text-sm text-muted-foreground">Carregando visor…</p>}><DocumentPage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
