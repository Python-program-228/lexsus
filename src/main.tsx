import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@heroui/react";
import App from "./App";
import { Toaster } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/tooltip";
import "./index.css";
import "./App.css";

document.documentElement.classList.add("dark");
document.documentElement.setAttribute("data-theme", "dark");

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