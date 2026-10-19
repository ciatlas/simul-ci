import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { bootApp } from './app/boot';
import { AppProvider } from './app/providers';
import { router } from './router';
import './index.css';

const app = bootApp();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider app={app}>
      <RouterProvider router={router} />
    </AppProvider>
  </StrictMode>,
);
