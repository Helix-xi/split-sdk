import React, { createContext, useContext, type CSSProperties, type ReactNode } from "react";

export interface WhiteLabelLabels {
  disputeInProgress: string;
  active: string;
  resolved: string;
  disputeReason: string;
  openedBy: string;
  timeOpened: string;
  arbitrator: string;
  you: string;
  finalDecision: string;
  submitEvidence: string;
  loadingTimeline: string;
  noEvents: string;
  disputeTimeline: string;
  invoiceTitle: string;
  invoiceDetails: string;
  invoiceNotFound: string;
  errorLoadingInvoice: string;
  retry: string;
  creator: string;
  totalAmount: string;
  funded: string;
  deadline: string;
  recipients: string;
}

export interface WhiteLabelTheme {
  primary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  surface: string;
  text: string;
}

export interface WhiteLabelConfig {
  brandName?: string;
  logoUrl?: string;
  labels?: Partial<WhiteLabelLabels>;
  theme?: Partial<WhiteLabelTheme>;
}

export interface WhiteLabelProviderProps {
  config: WhiteLabelConfig;
  className?: string;
  children: ReactNode;
}

export interface WhiteLabelContextValue {
  brandName?: string;
  logoUrl?: string;
  labels: Partial<WhiteLabelLabels>;
  theme: Partial<WhiteLabelTheme>;
}

const WhiteLabelContext = createContext<WhiteLabelContextValue>({ labels: {}, theme: {} });

/** Provides branding, semantic UI labels, and theme tokens to SDK UI components. */
export function WhiteLabelProvider({
  config,
  className = "",
  children,
}: WhiteLabelProviderProps): React.ReactElement {
  const parent = useContext(WhiteLabelContext);
  const value: WhiteLabelContextValue = {
    brandName: config.brandName ?? parent.brandName,
    logoUrl: config.logoUrl ?? parent.logoUrl,
    labels: { ...parent.labels, ...config.labels },
    theme: { ...parent.theme, ...config.theme },
  };
  const style = {} as CSSProperties & Record<string, string>;
  if (value.theme.primary) style["--stellar-split-primary"] = value.theme.primary;
  if (value.theme.accent) style["--stellar-split-accent"] = value.theme.accent;
  if (value.theme.success) style["--stellar-split-success"] = value.theme.success;
  if (value.theme.warning) style["--stellar-split-warning"] = value.theme.warning;
  if (value.theme.danger) style["--stellar-split-danger"] = value.theme.danger;
  if (value.theme.info) style["--stellar-split-info"] = value.theme.info;
  if (value.theme.surface) style["--stellar-split-surface"] = value.theme.surface;
  if (value.theme.text) style["--stellar-split-text"] = value.theme.text;

  return (
    <WhiteLabelContext.Provider value={value}>
      <div className={`stellar-split-white-label ${className}`.trim()} style={style}>
        {(value.brandName || value.logoUrl) && (
          <div className="stellar-split-white-label__brand" data-testid="white-label-brand">
            {value.logoUrl && <img src={value.logoUrl} alt={value.brandName ?? ""} />}
            {value.brandName && <span>{value.brandName}</span>}
          </div>
        )}
        {children}
      </div>
    </WhiteLabelContext.Provider>
  );
}

/** Read the nearest white-label configuration, or empty defaults outside a provider. */
export function useWhiteLabel(): WhiteLabelContextValue {
  return useContext(WhiteLabelContext);
}