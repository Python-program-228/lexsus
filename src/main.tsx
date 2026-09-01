import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@heroui/react";
import App from "./App";
import { Toaster } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import { applyTheme, loadTheme } from "./hooks/useTheme";
import "./index.css";
import "./App.css";

applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider locale="en">
      <TooltipProvider>
        <Toaster>
          <App />
        </Toaster>
      </TooltipProvider>
    </I18nProvider>
  </React.StrictMode>,
);