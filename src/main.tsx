import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./styles.css";
import "./integrations.css";
import "./marketing.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <React.Suspense
        fallback={
          <main className="invite-error" role="status">
            Loading Invibox…
          </main>
        }
      >
        <App />
      </React.Suspense>
    </ErrorBoundary>
  </React.StrictMode>,
);
