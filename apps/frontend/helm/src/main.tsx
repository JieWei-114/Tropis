import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './lib/i18n';
import App from './app/App.tsx';
import { reportWebVitals } from './lib/webVitals.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Measure real-user Core Web Vitals and pipe them into the tracking pipeline.
reportWebVitals();
