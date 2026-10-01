import { cssr } from '../utils/cssr'

const TAILWINDCSS_GENERATED = `
/*! tailwindcss v4.1.11 | MIT License | https://tailwindcss.com */
@layer properties;
@layer theme, base, components, utilities;
@layer theme {
  :root, :host {
    --spacing: 0.25rem;
    --font-weight-normal: 400;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --default-transition-duration: 150ms;
    --default-transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }
}
@layer utilities {
  .collapse {
    visibility: collapse;
  }
  .visible {
    visibility: visible;
  }
  .absolute {
    position: absolute;
  }
  .fixed {
    position: fixed;
  }
  .relative {
    position: relative;
  }
  .static {
    position: static;
  }
  .sticky {
    position: sticky;
  }
  .inset-0 {
    inset: calc(var(--spacing) * 0);
  }
  .top-0 {
    top: calc(var(--spacing) * 0);
  }
  .top-1\\/2 {
    top: calc(1/2 * 100%);
  }
  .right-\\[8px\\] {
    right: 8px;
  }
  .isolate {
    isolation: isolate;
  }
  .z-30 {
    z-index: 30;
  }
  .z-\\[1\\] {
    z-index: 1;
  }
  .z-\\[2\\] {
    z-index: 2;
  }
  .z-\\[1000\\] {
    z-index: 1000;
  }
  .order-\\[1\\] {
    order: 1;
  }
  .order-\\[3\\] {
    order: 3;
  }
  .col-span-3 {
    grid-column: span 3 / span 3;
  }
  .col-span-4 {
    grid-column: span 4 / span 4;
  }
  .col-span-5 {
    grid-column: span 5 / span 5;
  }
  .col-span-6 {
    grid-column: span 6 / span 6;
  }
  .col-span-8 {
    grid-column: span 8 / span 8;
  }
  .col-span-12 {
    grid-column: span 12 / span 12;
  }
  .col-span-full {
    grid-column: 1 / -1;
  }
  .container {
    width: 100%;
    @media (width >= 40rem) {
      max-width: 40rem;
    }
    @media (width >= 48rem) {
      max-width: 48rem;
    }
    @media (width >= 64rem) {
      max-width: 64rem;
    }
    @media (width >= 80rem) {
      max-width: 80rem;
    }
    @media (width >= 96rem) {
      max-width: 96rem;
    }
  }
  .m-0 {
    margin: calc(var(--spacing) * 0);
  }
  .-mx-\\[2px\\] {
    margin-inline: calc(2px * -1);
  }
  .mx-0 {
    margin-inline: calc(var(--spacing) * 0);
  }
  .mx-\\[-8px\\] {
    margin-inline: -8px;
  }
  .mx-auto {
    margin-inline: auto;
  }
  .my-0 {
    margin-block: calc(var(--spacing) * 0);
  }
  .my-\\[4px\\] {
    margin-block: 4px;
  }
  .mt-\\[2px\\] {
    margin-top: 2px;
  }
  .mt-\\[4px\\] {
    margin-top: 4px;
  }
  .mt-\\[6px\\] {
    margin-top: 6px;
  }
  .mt-\\[8px\\] {
    margin-top: 8px;
  }
  .mt-\\[12px\\] {
    margin-top: 12px;
  }
  .mt-\\[20px\\] {
    margin-top: 20px;
  }
  .mr-auto {
    margin-right: auto;
  }
  .mb-0 {
    margin-bottom: calc(var(--spacing) * 0);
  }
  .mb-\\[4px\\] {
    margin-bottom: 4px;
  }
  .mb-\\[10px\\] {
    margin-bottom: 10px;
  }
  .mb-\\[12px\\] {
    margin-bottom: 12px;
  }
  .mb-\\[14px\\] {
    margin-bottom: 14px;
  }
  .-ml-1 {
    margin-left: calc(var(--spacing) * -1);
  }
  .ml-\\[4px\\] {
    margin-left: 4px;
  }
  .ml-\\[8px\\] {
    margin-left: 8px;
  }
  .ml-auto {
    margin-left: auto;
  }
  .box-border {
    box-sizing: border-box;
  }
  .line-clamp-1 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
  }
  .line-clamp-2 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }
  .line-clamp-none {
    overflow: visible;
    display: block;
    -webkit-box-orient: horizontal;
    -webkit-line-clamp: unset;
  }
  .block {
    display: block;
  }
  .block\\! {
    display: block !important;
  }
  .contents {
    display: contents;
  }
  .flex {
    display: flex;
  }
  .grid {
    display: grid;
  }
  .hidden {
    display: none;
  }
  .inline {
    display: inline;
  }
  .inline-block {
    display: inline-block;
  }
  .inline-flex {
    display: inline-flex;
  }
  .table {
    display: table;
  }
  .h-\\[4px\\] {
    height: 4px;
  }
  .h-\\[8px\\] {
    height: 8px;
  }
  .h-\\[10px\\] {
    height: 10px;
  }
  .h-\\[14px\\] {
    height: 14px;
  }
  .h-\\[16px\\] {
    height: 16px;
  }
  .h-\\[18px\\] {
    height: 18px;
  }
  .h-\\[20px\\] {
    height: 20px;
  }
  .h-\\[22px\\] {
    height: 22px;
  }
  .h-\\[24px\\] {
    height: 24px;
  }
  .h-\\[28px\\] {
    height: 28px;
  }
  .h-\\[32px\\] {
    height: 32px;
  }
  .h-\\[36px\\] {
    height: 36px;
  }
  .h-\\[38px\\] {
    height: 38px;
  }
  .h-\\[40px\\] {
    height: 40px;
  }
  .h-\\[42px\\] {
    height: 42px;
  }
  .h-\\[44px\\] {
    height: 44px;
  }
  .h-\\[48px\\] {
    height: 48px;
  }
  .h-\\[56px\\] {
    height: 56px;
  }
  .h-\\[60px\\] {
    height: 60px;
  }
  .h-\\[calc\\(28px\\+var\\(--dsh-content-font-delta\\,0px\\)\\)\\] {
    height: calc(28px + var(--dsh-content-font-delta,0px));
  }
  .h-full {
    height: 100%;
  }
  .max-h-\\[60vh\\] {
    max-height: 60vh;
  }
  .max-h-\\[160px\\] {
    max-height: 160px;
  }
  .max-h-\\[180px\\] {
    max-height: 180px;
  }
  .max-h-\\[calc\\(100vh-160px\\)\\]\\! {
    max-height: calc(100vh - 160px) !important;
  }
  .max-h-\\[min\\(400px\\,52vh\\)\\] {
    max-height: min(400px, 52vh);
  }
  .min-h-0 {
    min-height: calc(var(--spacing) * 0);
  }
  .min-h-\\[28px\\] {
    min-height: 28px;
  }
  .min-h-\\[64px\\] {
    min-height: 64px;
  }
  .min-h-\\[96px\\] {
    min-height: 96px;
  }
  .min-h-\\[240px\\] {
    min-height: 240px;
  }
  .min-h-\\[260px\\] {
    min-height: 260px;
  }
  .min-h-\\[320px\\] {
    min-height: 320px;
  }
  .min-h-full {
    min-height: 100%;
  }
  .w-\\[8px\\] {
    width: 8px;
  }
  .w-\\[10px\\] {
    width: 10px;
  }
  .w-\\[14px\\] {
    width: 14px;
  }
  .w-\\[16px\\] {
    width: 16px;
  }
  .w-\\[20px\\] {
    width: 20px;
  }
  .w-\\[22px\\] {
    width: 22px;
  }
  .w-\\[24px\\] {
    width: 24px;
  }
  .w-\\[28px\\] {
    width: 28px;
  }
  .w-\\[36px\\] {
    width: 36px;
  }
  .w-\\[44px\\] {
    width: 44px;
  }
  .w-\\[48px\\] {
    width: 48px;
  }
  .w-\\[56px\\] {
    width: 56px;
  }
  .w-\\[200px\\] {
    width: 200px;
  }
  .w-\\[calc\\(28px\\+var\\(--dsh-content-font-delta\\,0px\\)\\)\\] {
    width: calc(28px + var(--dsh-content-font-delta,0px));
  }
  .w-\\[calc\\(100\\%\\+4px\\)\\] {
    width: calc(100% + 4px);
  }
  .w-\\[calc\\(100\\%_-_2_\\*_var\\(--dsh-composer-side-clearance\\)_-_4_\\*_var\\(--dsh-composer-dock-inset\\)\\)\\] {
    width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset));
  }
  .w-\\[min\\(640px\\,100\\%\\)\\]\\! {
    width: min(640px, 100%) !important;
  }
  .w-\\[min\\(680px\\,100\\%\\)\\]\\! {
    width: min(680px, 100%) !important;
  }
  .w-\\[min\\(760px\\,100\\%\\)\\]\\! {
    width: min(760px, 100%) !important;
  }
  .w-\\[min\\(calc\\(var\\(--dsh-composer-card-max-width\\)_\\+_2_\\*_var\\(--dsh-composer-side-clearance\\)\\)\\,100\\%\\)\\] {
    width: min(calc(var(--dsh-composer-card-max-width) + 2 * var(--dsh-composer-side-clearance)), 100%);
  }
  .w-\\[var\\(--dsh-settings-rail-width\\)\\] {
    width: var(--dsh-settings-rail-width);
  }
  .w-full {
    width: 100%;
  }
  .w-full\\! {
    width: 100% !important;
  }
  .max-w-\\[40\\%\\] {
    max-width: 40%;
  }
  .max-w-\\[200px\\] {
    max-width: 200px;
  }
  .max-w-\\[220px\\] {
    max-width: 220px;
  }
  .max-w-\\[280px\\] {
    max-width: 280px;
  }
  .max-w-\\[460px\\] {
    max-width: 460px;
  }
  .max-w-\\[960px\\] {
    max-width: 960px;
  }
  .max-w-\\[calc\\(var\\(--dsh-composer-card-max-width\\)_-_4_\\*_var\\(--dsh-composer-dock-inset\\)\\)\\] {
    max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset));
  }
  .max-w-\\[min\\(100\\%\\,240px\\)\\] {
    max-width: min(100%, 240px);
  }
  .max-w-\\[min\\(100\\%\\,360px\\)\\] {
    max-width: min(100%, 360px);
  }
  .max-w-full {
    max-width: 100%;
  }
  .min-w-0 {
    min-width: calc(var(--spacing) * 0);
  }
  .min-w-\\[72px\\] {
    min-width: 72px;
  }
  .min-w-\\[220px\\] {
    min-width: 220px;
  }
  .flex-1 {
    flex: 1;
  }
  .flex-\\[0_1_280px\\] {
    flex: 0 1 280px;
  }
  .flex-\\[1_1_100\\%\\] {
    flex: 1 1 100%;
  }
  .flex-\\[1_1_220px\\] {
    flex: 1 1 220px;
  }
  .flex-\\[1_1_auto\\] {
    flex: 1 1 auto;
  }
  .flex-none {
    flex: none;
  }
  .shrink-0 {
    flex-shrink: 0;
  }
  .-translate-y-1\\/2 {
    --tw-translate-y: calc(calc(1/2 * 100%) * -1);
    translate: var(--tw-translate-x) var(--tw-translate-y);
  }
  .transform {
    transform: var(--tw-rotate-x,) var(--tw-rotate-y,) var(--tw-rotate-z,) var(--tw-skew-x,) var(--tw-skew-y,);
  }
  .cursor-\\[inherit\\] {
    cursor: inherit;
  }
  .cursor-col-resize {
    cursor: col-resize;
  }
  .cursor-pointer {
    cursor: pointer;
  }
  .touch-none {
    touch-action: none;
  }
  .resize {
    resize: both;
  }
  .resize-y {
    resize: vertical;
  }
  .list-none {
    list-style-type: none;
  }
  .grid-cols-\\[minmax\\(0\\,1fr\\)\\] {
    grid-template-columns: minmax(0,1fr);
  }
  .grid-cols-\\[repeat\\(2\\,minmax\\(0\\,1fr\\)\\)\\] {
    grid-template-columns: repeat(2,minmax(0,1fr));
  }
  .grid-cols-\\[repeat\\(12\\,minmax\\(0\\,1fr\\)\\)\\] {
    grid-template-columns: repeat(12,minmax(0,1fr));
  }
  .grid-rows-\\[0fr\\] {
    grid-template-rows: 0fr;
  }
  .grid-rows-\\[1fr\\] {
    grid-template-rows: 1fr;
  }
  .flex-col {
    flex-direction: column;
  }
  .flex-wrap {
    flex-wrap: wrap;
  }
  .items-center {
    align-items: center;
  }
  .items-end {
    align-items: flex-end;
  }
  .items-start {
    align-items: flex-start;
  }
  .items-stretch {
    align-items: stretch;
  }
  .justify-between {
    justify-content: space-between;
  }
  .justify-center {
    justify-content: center;
  }
  .justify-end {
    justify-content: flex-end;
  }
  .gap-0 {
    gap: calc(var(--spacing) * 0);
  }
  .gap-8 {
    gap: calc(var(--spacing) * 8);
  }
  .gap-\\[1px\\] {
    gap: 1px;
  }
  .gap-\\[2px\\] {
    gap: 2px;
  }
  .gap-\\[4px\\] {
    gap: 4px;
  }
  .gap-\\[5px\\] {
    gap: 5px;
  }
  .gap-\\[6px\\] {
    gap: 6px;
  }
  .gap-\\[7px\\] {
    gap: 7px;
  }
  .gap-\\[8px\\] {
    gap: 8px;
  }
  .gap-\\[10px\\] {
    gap: 10px;
  }
  .gap-\\[10px_12px\\] {
    gap: 10px 12px;
  }
  .gap-\\[12px\\] {
    gap: 12px;
  }
  .gap-\\[14px\\] {
    gap: 14px;
  }
  .gap-\\[16px\\] {
    gap: 16px;
  }
  .gap-\\[20px\\] {
    gap: 20px;
  }
  .gap-\\[24px\\] {
    gap: 24px;
  }
  .self-center {
    align-self: center;
  }
  .self-start {
    align-self: flex-start;
  }
  .self-stretch {
    align-self: stretch;
  }
  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .overflow-auto {
    overflow: auto;
  }
  .overflow-hidden {
    overflow: hidden;
  }
  .overflow-y-auto {
    overflow-y: auto;
  }
  .rounded {
    border-radius: 0.25rem;
  }
  .rounded-\\[2px\\] {
    border-radius: 2px;
  }
  .rounded-\\[3px\\] {
    border-radius: 3px;
  }
  .rounded-\\[4px\\] {
    border-radius: 4px;
  }
  .rounded-\\[6px\\] {
    border-radius: 6px;
  }
  .rounded-\\[8px\\] {
    border-radius: 8px;
  }
  .rounded-\\[10px\\] {
    border-radius: 10px;
  }
  .rounded-\\[12px\\] {
    border-radius: 12px;
  }
  .rounded-\\[14px\\] {
    border-radius: 14px;
  }
  .rounded-full {
    border-radius: calc(infinity * 1px);
  }
  .rounded-lg {
    border-radius: var(--dsw-radius-lg);
  }
  .rounded-md {
    border-radius: var(--dsw-radius-md);
  }
  .rounded-sm {
    border-radius: var(--dsw-radius-sm);
  }
  .rounded-xl {
    border-radius: var(--dsw-radius-xl);
  }
  .rounded-xs {
    border-radius: var(--dsw-radius-xs);
  }
  .rounded-tl-\\[16px\\] {
    border-top-left-radius: 16px;
  }
  .border {
    border-style: var(--tw-border-style);
    border-width: 1px;
  }
  .border-0 {
    border-style: var(--tw-border-style);
    border-width: 0px;
  }
  .border-\\[0\\.5px\\] {
    border-style: var(--tw-border-style);
    border-width: 0.5px;
  }
  .border-t {
    border-top-style: var(--tw-border-style);
    border-top-width: 1px;
  }
  .border-b-\\[0\\.5px\\] {
    border-bottom-style: var(--tw-border-style);
    border-bottom-width: 0.5px;
  }
  .border-l-2 {
    border-left-style: var(--tw-border-style);
    border-left-width: 2px;
  }
  .border-dashed {
    --tw-border-style: dashed;
    border-style: dashed;
  }
  .border-none {
    --tw-border-style: none;
    border-style: none;
  }
  .border-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-state-business-primary\\)_35\\%\\,transparent\\)\\] {
    border-color: var(--dsw-alias-state-business-primary);
    @supports (color: color-mix(in lab, red, red)) {
      border-color: color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);
    }
  }
  .border-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-state-error-primary\\)_30\\%\\,transparent\\)\\] {
    border-color: var(--dsw-alias-state-error-primary);
    @supports (color: color-mix(in lab, red, red)) {
      border-color: color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);
    }
  }
  .border-\\[color\\:var\\(--dsw-alias-line-secondary\\,currentColor\\)\\] {
    border-color: var(--dsw-alias-line-secondary,currentColor);
  }
  .border-border-l2 {
    border-color: var(--dsw-alias-border-l2);
  }
  .border-border-l3 {
    border-color: var(--dsw-alias-border-l3);
  }
  .border-border-l4 {
    border-color: var(--dsw-alias-border-l4);
  }
  .border-border-weak {
    border-color: var(--dsw-alias-border-weak, rgba(127, 127, 127, 0.2));
  }
  .border-brand {
    border-color: var(--dsw-alias-brand-primary);
  }
  .border-business\\/35 {
    border-color: var(--dsw-alias-state-business-primary);
    @supports (color: color-mix(in lab, red, red)) {
      border-color: color-mix(in oklab, var(--dsw-alias-state-business-primary) 35%, transparent);
    }
  }
  .border-current {
    border-color: currentcolor;
  }
  .border-error\\/35 {
    border-color: var(--dsw-alias-state-error-primary);
    @supports (color: color-mix(in lab, red, red)) {
      border-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 35%, transparent);
    }
  }
  .border-success\\/35 {
    border-color: var(--dsw-alias-state-success-primary);
    @supports (color: color-mix(in lab, red, red)) {
      border-color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 35%, transparent);
    }
  }
  .border-t-border-l2 {
    border-top-color: var(--dsw-alias-border-l2);
  }
  .border-l-transparent {
    border-left-color: transparent;
  }
  .bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-state-business-primary\\)_8\\%\\,transparent\\)\\] {
    background-color: var(--dsw-alias-state-business-primary);
    @supports (color: color-mix(in lab, red, red)) {
      background-color: color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent);
    }
  }
  .bg-\\[color\\:var\\(--swatch-color\\)\\] {
    background-color: var(--swatch-color);
  }
  .bg-\\[var\\(--dsw-alias-bg-base\\)\\] {
    background-color: var(--dsw-alias-bg-base);
  }
  .bg-\\[var\\(--dsw-alias-bg-base\\,var\\(--dsw-alias-bg-module-platform\\)\\)\\] {
    background-color: var(--dsw-alias-bg-base,var(--dsw-alias-bg-module-platform));
  }
  .bg-\\[var\\(--dsw-alias-button-elevated-fill\\)\\] {
    background-color: var(--dsw-alias-button-elevated-fill);
  }
  .bg-\\[var\\(--dsw-alias-surface-tinted\\)\\] {
    background-color: var(--dsw-alias-surface-tinted);
  }
  .bg-\\[var\\(--dsw-specific-sidebar-fill\\)\\] {
    background-color: var(--dsw-specific-sidebar-fill);
  }
  .bg-\\[var\\(--dsw-specific-sidebar-nav-item-active\\)\\] {
    background-color: var(--dsw-specific-sidebar-nav-item-active);
  }
  .bg-border-l2 {
    background-color: var(--dsw-alias-border-l2);
  }
  .bg-brand {
    background-color: var(--dsw-alias-brand-primary);
  }
  .bg-business\\/8 {
    background-color: var(--dsw-alias-state-business-primary);
    @supports (color: color-mix(in lab, red, red)) {
      background-color: color-mix(in oklab, var(--dsw-alias-state-business-primary) 8%, transparent);
    }
  }
  .bg-current {
    background-color: currentcolor;
  }
  .bg-error\\/8 {
    background-color: var(--dsw-alias-state-error-primary);
    @supports (color: color-mix(in lab, red, red)) {
      background-color: color-mix(in oklab, var(--dsw-alias-state-error-primary) 8%, transparent);
    }
  }
  .bg-hover {
    background-color: var(--dsw-alias-interactive-bg-hover);
  }
  .bg-layer-1 {
    background-color: var(--dsw-alias-bg-layer-1);
  }
  .bg-layer-3 {
    background-color: var(--dsw-alias-bg-layer-3);
  }
  .bg-module-platform {
    background-color: var(--dsw-alias-bg-module-platform);
  }
  .bg-primary-fill {
    background-color: var(--dsw-alias-button-primary-fill);
  }
  .bg-success\\/8 {
    background-color: var(--dsw-alias-state-success-primary);
    @supports (color: color-mix(in lab, red, red)) {
      background-color: color-mix(in oklab, var(--dsw-alias-state-success-primary) 8%, transparent);
    }
  }
  .bg-transparent {
    background-color: transparent;
  }
  .bg-\\[image\\:linear-gradient\\(to_top_right\\,transparent_calc\\(50\\%_-_1px\\)\\,var\\(--dsw-alias-label-tertiary\\)\\,transparent_calc\\(50\\%_\\+_1px\\)\\)\\] {
    background-image: linear-gradient(to top right,transparent calc(50% - 1px),var(--dsw-alias-label-tertiary),transparent calc(50% + 1px));
  }
  .object-cover {
    object-fit: cover;
  }
  .p-0 {
    padding: calc(var(--spacing) * 0);
  }
  .p-\\[2px\\] {
    padding: 2px;
  }
  .p-\\[6px\\] {
    padding: 6px;
  }
  .p-\\[8px\\] {
    padding: 8px;
  }
  .p-\\[10px\\] {
    padding: 10px;
  }
  .p-\\[12px\\] {
    padding: 12px;
  }
  .px-\\[2px\\] {
    padding-inline: 2px;
  }
  .px-\\[6px\\] {
    padding-inline: 6px;
  }
  .px-\\[7px\\] {
    padding-inline: 7px;
  }
  .px-\\[8px\\] {
    padding-inline: 8px;
  }
  .px-\\[10px\\] {
    padding-inline: 10px;
  }
  .px-\\[12px\\] {
    padding-inline: 12px;
  }
  .px-\\[14px\\] {
    padding-inline: 14px;
  }
  .px-\\[16px\\] {
    padding-inline: 16px;
  }
  .px-\\[24px\\] {
    padding-inline: 24px;
  }
  .px-\\[36px\\] {
    padding-inline: 36px;
  }
  .px-\\[clamp\\(24px\\,4vw\\,48px\\)\\] {
    padding-inline: clamp(24px, 4vw, 48px);
  }
  .py-\\[1px\\] {
    padding-block: 1px;
  }
  .py-\\[2px\\] {
    padding-block: 2px;
  }
  .py-\\[4px\\] {
    padding-block: 4px;
  }
  .py-\\[5px\\] {
    padding-block: 5px;
  }
  .py-\\[6px\\] {
    padding-block: 6px;
  }
  .py-\\[7px\\] {
    padding-block: 7px;
  }
  .py-\\[8px\\] {
    padding-block: 8px;
  }
  .py-\\[9px\\] {
    padding-block: 9px;
  }
  .py-\\[10px\\] {
    padding-block: 10px;
  }
  .py-\\[12px\\] {
    padding-block: 12px;
  }
  .py-\\[14px\\] {
    padding-block: 14px;
  }
  .py-\\[16px\\] {
    padding-block: 16px;
  }
  .py-\\[24px\\] {
    padding-block: 24px;
  }
  .py-\\[28px\\] {
    padding-block: 28px;
  }
  .py-\\[32px\\] {
    padding-block: 32px;
  }
  .py-\\[40px\\] {
    padding-block: 40px;
  }
  .py-\\[48px\\] {
    padding-block: 48px;
  }
  .pt-\\[2px\\] {
    padding-top: 2px;
  }
  .pt-\\[12px\\] {
    padding-top: 12px;
  }
  .pt-\\[28px\\] {
    padding-top: 28px;
  }
  .pr-\\[4px\\] {
    padding-right: 4px;
  }
  .pr-\\[5px\\] {
    padding-right: 5px;
  }
  .pr-\\[10px\\] {
    padding-right: 10px;
  }
  .pb-\\[46px\\] {
    padding-bottom: 46px;
  }
  .pb-\\[48px\\] {
    padding-bottom: 48px;
  }
  .pl-\\[2px\\] {
    padding-left: 2px;
  }
  .pl-\\[8px\\] {
    padding-left: 8px;
  }
  .pl-\\[12px\\] {
    padding-left: 12px;
  }
  .text-center {
    text-align: center;
  }
  .text-left {
    text-align: left;
  }
  .text-right {
    text-align: right;
  }
  .align-middle {
    vertical-align: middle;
  }
  .\\[font-family\\:cursive\\] {
    font-family: cursive;
  }
  .\\[font-family\\:inherit\\] {
    font-family: inherit;
  }
  .\\[font-family\\:monospace\\] {
    font-family: monospace;
  }
  .\\[font-family\\:var\\(--ds-font-family-code\\)\\] {
    font-family: var(--ds-font-family-code);
  }
  .font-mono {
    font-family: var(--ds-font-family-code);
  }
  .font-sans {
    font-family: var(--dsw-font-family);
  }
  .text-\\[10px\\] {
    font-size: 10px;
  }
  .text-\\[11px\\] {
    font-size: 11px;
  }
  .text-\\[12px\\] {
    font-size: 12px;
  }
  .text-\\[13px\\] {
    font-size: 13px;
  }
  .text-\\[14px\\] {
    font-size: 14px;
  }
  .text-\\[16px\\] {
    font-size: 16px;
  }
  .text-\\[18px\\] {
    font-size: 18px;
  }
  .text-\\[20px\\] {
    font-size: 20px;
  }
  .text-\\[22px\\] {
    font-size: 22px;
  }
  .text-\\[24px\\] {
    font-size: 24px;
  }
  .text-\\[28px\\] {
    font-size: 28px;
  }
  .leading-\\[1\\.5\\] {
    --tw-leading: 1.5;
    line-height: 1.5;
  }
  .leading-\\[1\\.55\\] {
    --tw-leading: 1.55;
    line-height: 1.55;
  }
  .leading-\\[16px\\] {
    --tw-leading: 16px;
    line-height: 16px;
  }
  .leading-\\[17px\\] {
    --tw-leading: 17px;
    line-height: 17px;
  }
  .leading-\\[18px\\] {
    --tw-leading: 18px;
    line-height: 18px;
  }
  .leading-\\[19px\\] {
    --tw-leading: 19px;
    line-height: 19px;
  }
  .leading-\\[20px\\] {
    --tw-leading: 20px;
    line-height: 20px;
  }
  .leading-\\[21px\\] {
    --tw-leading: 21px;
    line-height: 21px;
  }
  .leading-\\[22px\\] {
    --tw-leading: 22px;
    line-height: 22px;
  }
  .leading-\\[24px\\] {
    --tw-leading: 24px;
    line-height: 24px;
  }
  .leading-\\[28px\\] {
    --tw-leading: 28px;
    line-height: 28px;
  }
  .leading-\\[32px\\] {
    --tw-leading: 32px;
    line-height: 32px;
  }
  .leading-none {
    --tw-leading: 1;
    line-height: 1;
  }
  .font-medium {
    --tw-font-weight: var(--font-weight-medium);
    font-weight: var(--font-weight-medium);
  }
  .font-normal {
    --tw-font-weight: var(--font-weight-normal);
    font-weight: var(--font-weight-normal);
  }
  .font-semibold {
    --tw-font-weight: var(--font-weight-semibold);
    font-weight: var(--font-weight-semibold);
  }
  .\\[overflow-wrap\\:anywhere\\] {
    overflow-wrap: anywhere;
  }
  .break-all {
    word-break: break-all;
  }
  .whitespace-nowrap {
    white-space: nowrap;
  }
  .whitespace-pre-wrap {
    white-space: pre-wrap;
  }
  .text-\\[var\\(--dsw-alias-label-caption\\)\\] {
    color: var(--dsw-alias-label-caption);
  }
  .text-\\[var\\(--dsw-alias-label-primary\\)\\] {
    color: var(--dsw-alias-label-primary);
  }
  .text-\\[var\\(--dsw-alias-label-primary-dimmed\\,var\\(--dsw-alias-label-dimmed\\)\\)\\] {
    color: var(--dsw-alias-label-primary-dimmed,var(--dsw-alias-label-dimmed));
  }
  .text-\\[var\\(--dsw-alias-label-secondary\\,var\\(--dsw-alias-label-primary\\)\\)\\] {
    color: var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));
  }
  .text-\\[var\\(--dsw-alias-state-warning-primary\\,\\#d48806\\)\\] {
    color: var(--dsw-alias-state-warning-primary,#d48806);
  }
  .text-\\[var\\(--dsw-alias-state-warning-primary\\,var\\(--dsw-alias-label-tertiary\\)\\)\\] {
    color: var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));
  }
  .text-brand {
    color: var(--dsw-alias-brand-primary);
  }
  .text-business {
    color: var(--dsw-alias-state-business-primary);
  }
  .text-dimmed {
    color: var(--dsw-alias-label-dimmed);
  }
  .text-error {
    color: var(--dsw-alias-state-error-primary);
  }
  .text-idle {
    color: var(--dsw-alias-state-idle-primary);
  }
  .text-inherit {
    color: inherit;
  }
  .text-primary {
    color: var(--dsw-alias-label-primary);
  }
  .text-primary-fg {
    color: var(--dsw-alias-label-primary-foreground);
  }
  .text-secondary {
    color: var(--dsw-alias-label-secondary);
  }
  .text-success {
    color: var(--dsw-alias-state-success-primary);
  }
  .text-tertiary {
    color: var(--dsw-alias-label-tertiary);
  }
  .text-warn {
    color: var(--dsw-alias-state-warn-primary);
  }
  .lowercase {
    text-transform: lowercase;
  }
  .tabular-nums {
    --tw-numeric-spacing: tabular-nums;
    font-variant-numeric: var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,);
  }
  .no-underline {
    text-decoration-line: none;
  }
  .underline {
    text-decoration-line: underline;
  }
  .decoration-transparent {
    text-decoration-color: transparent;
  }
  .underline-offset-\\[2px\\] {
    text-underline-offset: 2px;
  }
  .accent-\\[var\\(--dsw-alias-button-primary-fill\\)\\] {
    accent-color: var(--dsw-alias-button-primary-fill);
  }
  .accent-brand {
    accent-color: var(--dsw-alias-brand-primary);
  }
  .opacity-0 {
    opacity: 0%;
  }
  .opacity-55 {
    opacity: 55%;
  }
  .opacity-60 {
    opacity: 60%;
  }
  .opacity-100 {
    opacity: 100%;
  }
  .shadow {
    --tw-shadow: 0 1px 3px 0 var(--tw-shadow-color, rgb(0 0 0 / 0.1)), 0 1px 2px -1px var(--tw-shadow-color, rgb(0 0 0 / 0.1));
    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
  }
  .shadow-\\[inset_0_0_0_0\\.5px_var\\(--dsw-alias-border-l3\\)\\] {
    --tw-shadow: inset 0 0 0 0.5px var(--tw-shadow-color, var(--dsw-alias-border-l3));
    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
  }
  .shadow-\\[inset_0_0_0_1px_rgba\\(0\\,0\\,0\\,0\\.12\\)\\] {
    --tw-shadow: inset 0 0 0 1px var(--tw-shadow-color, rgba(0,0,0,0.12));
    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
  }
  .shadow-\\[var\\(--dsw-elevation-panel\\)\\] {
    --tw-shadow: var(--dsw-elevation-panel);
    box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
  }
  .outline {
    outline-style: var(--tw-outline-style);
    outline-width: 1px;
  }
  .outline-2 {
    outline-style: var(--tw-outline-style);
    outline-width: 2px;
  }
  .outline-offset-2 {
    outline-offset: 2px;
  }
  .outline-brand {
    outline-color: var(--dsw-alias-brand-primary);
  }
  .filter {
    filter: var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,);
  }
  .backdrop-filter {
    -webkit-backdrop-filter: var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,);
    backdrop-filter: var(--tw-backdrop-blur,) var(--tw-backdrop-brightness,) var(--tw-backdrop-contrast,) var(--tw-backdrop-grayscale,) var(--tw-backdrop-hue-rotate,) var(--tw-backdrop-invert,) var(--tw-backdrop-opacity,) var(--tw-backdrop-saturate,) var(--tw-backdrop-sepia,);
  }
  .transition {
    transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, visibility, content-visibility, overlay, pointer-events;
    transition-timing-function: var(--tw-ease, var(--default-transition-timing-function));
    transition-duration: var(--tw-duration, var(--default-transition-duration));
  }
  .transition-\\[text-decoration-color\\] {
    transition-property: text-decoration-color;
    transition-timing-function: var(--tw-ease, var(--default-transition-timing-function));
    transition-duration: var(--tw-duration, var(--default-transition-duration));
  }
  .transition-transform {
    transition-property: transform, translate, scale, rotate;
    transition-timing-function: var(--tw-ease, var(--default-transition-timing-function));
    transition-duration: var(--tw-duration, var(--default-transition-duration));
  }
  .duration-\\[120ms\\] {
    --tw-duration: 120ms;
    transition-duration: 120ms;
  }
  .ease-\\[ease\\] {
    --tw-ease: ease;
    transition-timing-function: ease;
  }
  .outline-none {
    --tw-outline-style: none;
    outline-style: none;
  }
  .\\[--dsh-chat-content-width\\:748px\\] {
    --dsh-chat-content-width: 748px;
  }
  .\\[--dsh-composer-card-max-width\\:calc\\(var\\(--dsh-chat-content-width\\)_\\+_32px\\)\\] {
    --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
  }
  .\\[--dsh-composer-side-clearance\\:16px\\] {
    --dsh-composer-side-clearance: 16px;
  }
  .\\[--dsw-alias-interactive-bg-hover\\:color-mix\\(in_srgb\\,var\\(--dsw-alias-state-error-primary\\)_8\\%\\,transparent\\)\\] {
    --dsw-alias-interactive-bg-hover: var(--dsw-alias-state-error-primary);
    @supports (color: color-mix(in lab, red, red)) {
      --dsw-alias-interactive-bg-hover: color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);
    }
  }
  .\\[--dsw-elevation-stroke-color\\:var\\(--dsw-alias-border-l1\\)\\] {
    --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  }
  .\\[corner-shape\\:round\\] {
    corner-shape: round;
  }
  .\\[transition\\:grid-template-rows_180ms_cubic-bezier\\(\\.16\\,1\\,\\.3\\,1\\)\\,opacity_140ms_ease\\] {
    transition: grid-template-rows 180ms cubic-bezier(.16,1,.3,1),opacity 140ms ease;
  }
  .\\[transition\\:width_200ms_ease\\] {
    transition: width 200ms ease;
  }
  .before\\:pointer-events-none {
    &::before {
      content: var(--tw-content);
      pointer-events: none;
    }
  }
  .before\\:absolute {
    &::before {
      content: var(--tw-content);
      position: absolute;
    }
  }
  .before\\:inset-0 {
    &::before {
      content: var(--tw-content);
      inset: calc(var(--spacing) * 0);
    }
  }
  .before\\:z-\\[-1\\] {
    &::before {
      content: var(--tw-content);
      z-index: -1;
    }
  }
  .before\\:rounded-\\[inherit\\] {
    &::before {
      content: var(--tw-content);
      border-radius: inherit;
    }
  }
  .before\\:bg-\\[var\\(--dsw-specific-menu\\)\\] {
    &::before {
      content: var(--tw-content);
      background-color: var(--dsw-specific-menu);
    }
  }
  .before\\:\\[backdrop-filter\\:var\\(--dsw-menu-backdrop-filter\\)\\] {
    &::before {
      content: var(--tw-content);
      backdrop-filter: var(--dsw-menu-backdrop-filter);
    }
  }
  .before\\:content-\\[\\"\\"\\] {
    &::before {
      content: var(--tw-content);
      --tw-content: "";
      content: var(--tw-content);
    }
  }
  .after\\:absolute {
    &::after {
      content: var(--tw-content);
      position: absolute;
    }
  }
  .after\\:inset-\\[20\\%\\] {
    &::after {
      content: var(--tw-content);
      inset: 20%;
    }
  }
  .after\\:inset-\\[25\\%\\] {
    &::after {
      content: var(--tw-content);
      inset: 25%;
    }
  }
  .after\\:rounded-full {
    &::after {
      content: var(--tw-content);
      border-radius: calc(infinity * 1px);
    }
  }
  .after\\:bg-current {
    &::after {
      content: var(--tw-content);
      background-color: currentcolor;
    }
  }
  .after\\:content-\\[\\"\\"\\] {
    &::after {
      content: var(--tw-content);
      --tw-content: "";
      content: var(--tw-content);
    }
  }
  .after\\:content-\\[\\'\\'\\] {
    &::after {
      content: var(--tw-content);
      --tw-content: '';
      content: var(--tw-content);
    }
  }
  .after\\:\\[corner-shape\\:round\\] {
    &::after {
      content: var(--tw-content);
      corner-shape: round;
    }
  }
  .last\\:border-b-0 {
    &:last-child {
      border-bottom-style: var(--tw-border-style);
      border-bottom-width: 0px;
    }
  }
  .hover\\:border-border-l4 {
    &:hover {
      @media (hover: hover) {
        border-color: var(--dsw-alias-border-l4);
      }
    }
  }
  .hover\\:bg-\\[var\\(--dsw-alias-bg-layer-4\\)\\] {
    &:hover {
      @media (hover: hover) {
        background-color: var(--dsw-alias-bg-layer-4);
      }
    }
  }
  .hover\\:bg-hover {
    &:hover {
      @media (hover: hover) {
        background-color: var(--dsw-alias-interactive-bg-hover);
      }
    }
  }
  .hover\\:text-secondary {
    &:hover {
      @media (hover: hover) {
        color: var(--dsw-alias-label-secondary);
      }
    }
  }
  .hover\\:not-disabled\\:bg-\\[var\\(--dsw-alias-button-floating-hover\\)\\] {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          background-color: var(--dsw-alias-button-floating-hover);
        }
      }
    }
  }
  .hover\\:not-disabled\\:bg-hover {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          background-color: var(--dsw-alias-interactive-bg-hover);
        }
      }
    }
  }
  .hover\\:not-disabled\\:bg-layer-1 {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          background-color: var(--dsw-alias-bg-layer-1);
        }
      }
    }
  }
  .hover\\:not-disabled\\:bg-primary-hover {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          background-color: var(--dsw-alias-button-primary-hover);
        }
      }
    }
  }
  .hover\\:not-disabled\\:text-primary {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          color: var(--dsw-alias-label-primary);
        }
      }
    }
  }
  .hover\\:not-disabled\\:text-secondary {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          color: var(--dsw-alias-label-secondary);
        }
      }
    }
  }
  .hover\\:not-disabled\\:underline {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          text-decoration-line: underline;
        }
      }
    }
  }
  .hover\\:not-disabled\\:decoration-current {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          text-decoration-color: currentcolor;
        }
      }
    }
  }
  .hover\\:not-disabled\\:decoration-secondary {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          text-decoration-color: var(--dsw-alias-label-secondary);
        }
      }
    }
  }
  .hover\\:not-disabled\\:underline-offset-2 {
    &:hover {
      @media (hover: hover) {
        &:not(*:disabled) {
          text-underline-offset: 2px;
        }
      }
    }
  }
  .focus-visible\\:border-business {
    &:focus-visible {
      border-color: var(--dsw-alias-state-business-primary);
    }
  }
  .focus-visible\\:bg-\\[var\\(--dsw-alias-bg-layer-4\\)\\] {
    &:focus-visible {
      background-color: var(--dsw-alias-bg-layer-4);
    }
  }
  .focus-visible\\:text-secondary {
    &:focus-visible {
      color: var(--dsw-alias-label-secondary);
    }
  }
  .focus-visible\\:shadow-\\[0_0_0_2px_color-mix\\(in_srgb\\,var\\(--dsw-alias-state-business-primary\\)_18\\%\\,transparent\\)\\] {
    &:focus-visible {
      --tw-shadow: 0 0 0 2px var(--tw-shadow-color, var(--dsw-alias-state-business-primary));
      @supports (color: color-mix(in lab, red, red)) {
        --tw-shadow: 0 0 0 2px var(--tw-shadow-color, color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent));
      }
      box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
    }
  }
  .focus-visible\\:shadow-focus-ring {
    &:focus-visible {
      --tw-shadow: 0 0 0 2px var(--tw-shadow-color, var(--dsw-alias-border-l3));
      box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
    }
  }
  .focus-visible\\:\\[outline\\:var\\(--dsw-focus-ring-width\\,2px\\)_solid_var\\(--dsw-focus-ring-color\\,var\\(--dsw-alias-state-business-primary\\)\\)\\] {
    &:focus-visible {
      outline: var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));
    }
  }
  .focus-visible\\:\\[outline-offset\\:1px\\] {
    &:focus-visible {
      outline-offset: 1px;
    }
  }
  .focus-visible\\:outline-none {
    &:focus-visible {
      --tw-outline-style: none;
      outline-style: none;
    }
  }
  .active\\:not-disabled\\:bg-active {
    &:active {
      &:not(*:disabled) {
        background-color: var(--dsw-alias-interactive-bg-active);
      }
    }
  }
  .disabled\\:cursor-default {
    &:disabled {
      cursor: default;
    }
  }
  .disabled\\:cursor-not-allowed {
    &:disabled {
      cursor: not-allowed;
    }
  }
  .disabled\\:text-\\[var\\(--dsw-alias-label-quaternary\\)\\] {
    &:disabled {
      color: var(--dsw-alias-label-quaternary);
    }
  }
  .disabled\\:text-dimmed {
    &:disabled {
      color: var(--dsw-alias-label-dimmed);
    }
  }
  .disabled\\:text-tertiary {
    &:disabled {
      color: var(--dsw-alias-label-tertiary);
    }
  }
  .disabled\\:opacity-40 {
    &:disabled {
      opacity: 40%;
    }
  }
  .disabled\\:opacity-50 {
    &:disabled {
      opacity: 50%;
    }
  }
  .disabled\\:opacity-60 {
    &:disabled {
      opacity: 60%;
    }
  }
  .has-\\[\\>input\\:disabled\\]\\:cursor-not-allowed {
    &:has(>input:disabled) {
      cursor: not-allowed;
    }
  }
  .has-\\[\\>input\\:disabled\\]\\:opacity-50 {
    &:has(>input:disabled) {
      opacity: 50%;
    }
  }
  .aria-expanded\\:bg-\\[var\\(--dsw-alias-bg-layer-4\\)\\] {
    &[aria-expanded="true"] {
      background-color: var(--dsw-alias-bg-layer-4);
    }
  }
  .aria-expanded\\:bg-hover {
    &[aria-expanded="true"] {
      background-color: var(--dsw-alias-interactive-bg-hover);
    }
  }
  .aria-expanded\\:text-secondary {
    &[aria-expanded="true"] {
      color: var(--dsw-alias-label-secondary);
    }
  }
  .data-\\[open\\=true\\]\\:rotate-180 {
    &[data-open="true"] {
      rotate: 180deg;
    }
  }
  .data-\\[status\\=cancelled\\]\\:text-tertiary {
    &[data-status="cancelled"] {
      color: var(--dsw-alias-label-tertiary);
    }
  }
  .data-\\[status\\=failed\\]\\:text-error {
    &[data-status="failed"] {
      color: var(--dsw-alias-state-error-primary);
    }
  }
  .data-\\[status\\=interrupted\\]\\:text-error {
    &[data-status="interrupted"] {
      color: var(--dsw-alias-state-error-primary);
    }
  }
  .data-\\[status\\=queued\\]\\:text-secondary {
    &[data-status="queued"] {
      color: var(--dsw-alias-label-secondary);
    }
  }
  .data-\\[status\\=running\\]\\:text-secondary {
    &[data-status="running"] {
      color: var(--dsw-alias-label-secondary);
    }
  }
  .data-\\[status\\=skipped\\]\\:text-tertiary {
    &[data-status="skipped"] {
      color: var(--dsw-alias-label-tertiary);
    }
  }
  .data-\\[status\\=succeeded\\]\\:text-success {
    &[data-status="succeeded"] {
      color: var(--dsw-alias-state-success-primary);
    }
  }
  .data-\\[tone\\=danger\\]\\:bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-state-error-primary\\)_10\\%\\,transparent\\)\\] {
    &[data-tone="danger"] {
      background-color: var(--dsw-alias-state-error-primary);
      @supports (color: color-mix(in lab, red, red)) {
        background-color: color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);
      }
    }
  }
  .data-\\[tone\\=danger\\]\\:text-error {
    &[data-tone="danger"] {
      color: var(--dsw-alias-state-error-primary);
    }
  }
  .data-\\[tone\\=info\\]\\:bg-\\[color-mix\\(in_srgb\\,var\\(--dsw-alias-state-business-primary\\)_10\\%\\,transparent\\)\\] {
    &[data-tone="info"] {
      background-color: var(--dsw-alias-state-business-primary);
      @supports (color: color-mix(in lab, red, red)) {
        background-color: color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);
      }
    }
  }
  .data-\\[tone\\=info\\]\\:text-business {
    &[data-tone="info"] {
      color: var(--dsw-alias-state-business-primary);
    }
  }
  .data-\\[tone\\=neutral\\]\\:bg-module-platform {
    &[data-tone="neutral"] {
      background-color: var(--dsw-alias-bg-module-platform);
    }
  }
  .data-\\[tone\\=neutral\\]\\:text-secondary {
    &[data-tone="neutral"] {
      color: var(--dsw-alias-label-secondary);
    }
  }
  .data-\\[tone\\=outline\\]\\:border-\\[0\\.5px\\] {
    &[data-tone="outline"] {
      border-style: var(--tw-border-style);
      border-width: 0.5px;
    }
  }
  .data-\\[tone\\=outline\\]\\:border-border-l4 {
    &[data-tone="outline"] {
      border-color: var(--dsw-alias-border-l4);
    }
  }
  .data-\\[tone\\=outline\\]\\:text-tertiary {
    &[data-tone="outline"] {
      color: var(--dsw-alias-label-tertiary);
    }
  }
  .max-\\[760px\\]\\:col-span-3 {
    @media (width < 760px) {
      grid-column: span 3 / span 3;
    }
  }
  .max-\\[760px\\]\\:col-span-6 {
    @media (width < 760px) {
      grid-column: span 6 / span 6;
    }
  }
  .max-\\[760px\\]\\:grid-cols-\\[repeat\\(6\\,minmax\\(0\\,1fr\\)\\)\\] {
    @media (width < 760px) {
      grid-template-columns: repeat(6,minmax(0,1fr));
    }
  }
  .max-\\[680px\\]\\:w-\\[140px\\] {
    @media (width < 680px) {
      width: 140px;
    }
  }
  .max-\\[680px\\]\\:max-w-\\[160px\\] {
    @media (width < 680px) {
      max-width: 160px;
    }
  }
  .max-\\[680px\\]\\:grid-cols-\\[minmax\\(0\\,1fr\\)\\] {
    @media (width < 680px) {
      grid-template-columns: minmax(0,1fr);
    }
  }
  .max-\\[520px\\]\\:col-span-6\\! {
    @media (width < 520px) {
      grid-column: span 6 / span 6 !important;
    }
  }
  .\\@max-\\[460px\\]\\:hidden {
    @container (width < 460px) {
      display: none;
    }
  }
  .\\[\\&_a\\]\\:text-business {
    & a {
      color: var(--dsw-alias-state-business-primary);
    }
  }
  .\\[\\&_code\\]\\:rounded-\\[4px\\] {
    & code {
      border-radius: 4px;
    }
  }
  .\\[\\&_code\\]\\:bg-layer-3 {
    & code {
      background-color: var(--dsw-alias-bg-layer-3);
    }
  }
  .\\[\\&_code\\]\\:px-\\[5px\\] {
    & code {
      padding-inline: 5px;
    }
  }
  .\\[\\&_code\\]\\:py-\\[1px\\] {
    & code {
      padding-block: 1px;
    }
  }
  .\\[\\&_code\\]\\:\\[font-family\\:var\\(--ds-font-family-code\\)\\] {
    & code {
      font-family: var(--ds-font-family-code);
    }
  }
  .\\[\\&_code\\]\\:text-\\[12px\\] {
    & code {
      font-size: 12px;
    }
  }
  .\\[\\&_h1\\]\\:mt-\\[14px\\] {
    & h1 {
      margin-top: 14px;
    }
  }
  .\\[\\&_h1\\]\\:mb-\\[6px\\] {
    & h1 {
      margin-bottom: 6px;
    }
  }
  .\\[\\&_h1\\]\\:text-\\[18px\\] {
    & h1 {
      font-size: 18px;
    }
  }
  .\\[\\&_h1\\]\\:leading-\\[1\\.4\\] {
    & h1 {
      --tw-leading: 1.4;
      line-height: 1.4;
    }
  }
  .\\[\\&_h1\\]\\:text-primary {
    & h1 {
      color: var(--dsw-alias-label-primary);
    }
  }
  .\\[\\&_h2\\]\\:mt-\\[14px\\] {
    & h2 {
      margin-top: 14px;
    }
  }
  .\\[\\&_h2\\]\\:mb-\\[6px\\] {
    & h2 {
      margin-bottom: 6px;
    }
  }
  .\\[\\&_h2\\]\\:text-\\[16px\\] {
    & h2 {
      font-size: 16px;
    }
  }
  .\\[\\&_h2\\]\\:leading-\\[1\\.4\\] {
    & h2 {
      --tw-leading: 1.4;
      line-height: 1.4;
    }
  }
  .\\[\\&_h2\\]\\:text-primary {
    & h2 {
      color: var(--dsw-alias-label-primary);
    }
  }
  .\\[\\&_h3\\]\\:m-0 {
    & h3 {
      margin: calc(var(--spacing) * 0);
    }
  }
  .\\[\\&_h3\\]\\:mt-\\[14px\\] {
    & h3 {
      margin-top: 14px;
    }
  }
  .\\[\\&_h3\\]\\:mb-\\[6px\\] {
    & h3 {
      margin-bottom: 6px;
    }
  }
  .\\[\\&_h3\\]\\:text-\\[13px\\] {
    & h3 {
      font-size: 13px;
    }
  }
  .\\[\\&_h3\\]\\:text-\\[14px\\] {
    & h3 {
      font-size: 14px;
    }
  }
  .\\[\\&_h3\\]\\:text-\\[16px\\] {
    & h3 {
      font-size: 16px;
    }
  }
  .\\[\\&_h3\\]\\:leading-\\[1\\.4\\] {
    & h3 {
      --tw-leading: 1.4;
      line-height: 1.4;
    }
  }
  .\\[\\&_h3\\]\\:leading-\\[20px\\] {
    & h3 {
      --tw-leading: 20px;
      line-height: 20px;
    }
  }
  .\\[\\&_h3\\]\\:leading-\\[24px\\] {
    & h3 {
      --tw-leading: 24px;
      line-height: 24px;
    }
  }
  .\\[\\&_h3\\]\\:font-medium {
    & h3 {
      --tw-font-weight: var(--font-weight-medium);
      font-weight: var(--font-weight-medium);
    }
  }
  .\\[\\&_h3\\]\\:font-semibold {
    & h3 {
      --tw-font-weight: var(--font-weight-semibold);
      font-weight: var(--font-weight-semibold);
    }
  }
  .\\[\\&_h3\\]\\:text-primary {
    & h3 {
      color: var(--dsw-alias-label-primary);
    }
  }
  .\\[\\&_h4\\]\\:mt-\\[14px\\] {
    & h4 {
      margin-top: 14px;
    }
  }
  .\\[\\&_h4\\]\\:mb-\\[6px\\] {
    & h4 {
      margin-bottom: 6px;
    }
  }
  .\\[\\&_h4\\]\\:text-\\[13px\\] {
    & h4 {
      font-size: 13px;
    }
  }
  .\\[\\&_h4\\]\\:leading-\\[1\\.4\\] {
    & h4 {
      --tw-leading: 1.4;
      line-height: 1.4;
    }
  }
  .\\[\\&_h4\\]\\:text-primary {
    & h4 {
      color: var(--dsw-alias-label-primary);
    }
  }
  .\\[\\&_input\\]\\:m-0 {
    & input {
      margin: calc(var(--spacing) * 0);
    }
  }
  .\\[\\&_input\\]\\:h-\\[12px\\] {
    & input {
      height: 12px;
    }
  }
  .\\[\\&_input\\]\\:w-\\[12px\\] {
    & input {
      width: 12px;
    }
  }
  .\\[\\&_input\\]\\:accent-brand {
    & input {
      accent-color: var(--dsw-alias-brand-primary);
    }
  }
  .\\[\\&_input\\:focus-visible\\]\\:shadow-focus-ring {
    & input:focus-visible {
      --tw-shadow: 0 0 0 2px var(--tw-shadow-color, var(--dsw-alias-border-l3));
      box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);
    }
  }
  .\\[\\&_ol\\]\\:my-\\[6px\\] {
    & ol {
      margin-block: 6px;
    }
  }
  .\\[\\&_ol\\]\\:pl-\\[20px\\] {
    & ol {
      padding-left: 20px;
    }
  }
  .\\[\\&_p\\]\\:m-0 {
    & p {
      margin: calc(var(--spacing) * 0);
    }
  }
  .\\[\\&_p\\]\\:my-\\[6px\\] {
    & p {
      margin-block: 6px;
    }
  }
  .\\[\\&_p\\]\\:leading-\\[20px\\] {
    & p {
      --tw-leading: 20px;
      line-height: 20px;
    }
  }
  .\\[\\&_pre\\]\\:my-\\[8px\\] {
    & pre {
      margin-block: 8px;
    }
  }
  .\\[\\&_pre\\]\\:overflow-x-auto {
    & pre {
      overflow-x: auto;
    }
  }
  .\\[\\&_pre\\]\\:rounded-\\[8px\\] {
    & pre {
      border-radius: 8px;
    }
  }
  .\\[\\&_pre\\]\\:border {
    & pre {
      border-style: var(--tw-border-style);
      border-width: 1px;
    }
  }
  .\\[\\&_pre\\]\\:border-border-l2 {
    & pre {
      border-color: var(--dsw-alias-border-l2);
    }
  }
  .\\[\\&_pre\\]\\:bg-layer-3 {
    & pre {
      background-color: var(--dsw-alias-bg-layer-3);
    }
  }
  .\\[\\&_pre\\]\\:px-\\[12px\\] {
    & pre {
      padding-inline: 12px;
    }
  }
  .\\[\\&_pre\\]\\:py-\\[10px\\] {
    & pre {
      padding-block: 10px;
    }
  }
  .\\[\\&_svg\\]\\:h-\\[11px\\] {
    & svg {
      height: 11px;
    }
  }
  .\\[\\&_svg\\]\\:h-\\[14px\\] {
    & svg {
      height: 14px;
    }
  }
  .\\[\\&_svg\\]\\:w-\\[11px\\] {
    & svg {
      width: 11px;
    }
  }
  .\\[\\&_svg\\]\\:w-\\[14px\\] {
    & svg {
      width: 14px;
    }
  }
  .\\[\\&_ul\\]\\:my-\\[6px\\] {
    & ul {
      margin-block: 6px;
    }
  }
  .\\[\\&_ul\\]\\:pl-\\[20px\\] {
    & ul {
      padding-left: 20px;
    }
  }
  .\\[\\&\\+\\&\\]\\:border-t {
    &+& {
      border-top-style: var(--tw-border-style);
      border-top-width: 1px;
    }
  }
  .\\[\\&\\+\\&\\]\\:border-border-weak {
    &+& {
      border-color: var(--dsw-alias-border-weak, rgba(127, 127, 127, 0.2));
    }
  }
  .\\[\\&\\+\\&\\]\\:border-t-border-l2 {
    &+& {
      border-top-color: var(--dsw-alias-border-l2);
    }
  }
  .\\[\\&\\:has\\(input\\:disabled\\)\\]\\:cursor-default {
    &:has(input:disabled) {
      cursor: default;
    }
  }
  .\\[\\&\\:has\\(input\\:disabled\\)\\]\\:opacity-60 {
    &:has(input:disabled) {
      opacity: 60%;
    }
  }
  .\\[\\&\\>\\*\\]\\:w-full {
    &>* {
      width: 100%;
    }
  }
  .\\[\\&\\>\\*\\]\\:max-w-\\[960px\\] {
    &>* {
      max-width: 960px;
    }
  }
  .\\[\\&\\>img\\]\\:absolute {
    &>img {
      position: absolute;
    }
  }
  .\\[\\&\\>img\\]\\:top-0 {
    &>img {
      top: calc(var(--spacing) * 0);
    }
  }
  .\\[\\&\\>img\\]\\:left-0 {
    &>img {
      left: calc(var(--spacing) * 0);
    }
  }
  .\\[\\&\\>img\\]\\:block {
    &>img {
      display: block;
    }
  }
  .\\[\\&\\>img\\]\\:h-\\[1100\\%\\] {
    &>img {
      height: 1100%;
    }
  }
  .\\[\\&\\>img\\]\\:h-full {
    &>img {
      height: 100%;
    }
  }
  .\\[\\&\\>img\\]\\:w-\\[800\\%\\] {
    &>img {
      width: 800%;
    }
  }
  .\\[\\&\\>img\\]\\:w-full {
    &>img {
      width: 100%;
    }
  }
  .\\[\\&\\>img\\]\\:max-w-none {
    &>img {
      max-width: none;
    }
  }
  .\\[\\&\\>img\\]\\:object-fill {
    &>img {
      object-fit: fill;
    }
  }
  .\\[\\&\\>span\\:first-child\\]\\:text-tertiary {
    &>span:first-child {
      color: var(--dsw-alias-label-tertiary);
    }
  }
}
@property --tw-translate-x {
  syntax: "*";
  inherits: false;
  initial-value: 0;
}
@property --tw-translate-y {
  syntax: "*";
  inherits: false;
  initial-value: 0;
}
@property --tw-translate-z {
  syntax: "*";
  inherits: false;
  initial-value: 0;
}
@property --tw-rotate-x {
  syntax: "*";
  inherits: false;
}
@property --tw-rotate-y {
  syntax: "*";
  inherits: false;
}
@property --tw-rotate-z {
  syntax: "*";
  inherits: false;
}
@property --tw-skew-x {
  syntax: "*";
  inherits: false;
}
@property --tw-skew-y {
  syntax: "*";
  inherits: false;
}
@property --tw-border-style {
  syntax: "*";
  inherits: false;
  initial-value: solid;
}
@property --tw-leading {
  syntax: "*";
  inherits: false;
}
@property --tw-font-weight {
  syntax: "*";
  inherits: false;
}
@property --tw-ordinal {
  syntax: "*";
  inherits: false;
}
@property --tw-slashed-zero {
  syntax: "*";
  inherits: false;
}
@property --tw-numeric-figure {
  syntax: "*";
  inherits: false;
}
@property --tw-numeric-spacing {
  syntax: "*";
  inherits: false;
}
@property --tw-numeric-fraction {
  syntax: "*";
  inherits: false;
}
@property --tw-shadow {
  syntax: "*";
  inherits: false;
  initial-value: 0 0 #0000;
}
@property --tw-shadow-color {
  syntax: "*";
  inherits: false;
}
@property --tw-shadow-alpha {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 100%;
}
@property --tw-inset-shadow {
  syntax: "*";
  inherits: false;
  initial-value: 0 0 #0000;
}
@property --tw-inset-shadow-color {
  syntax: "*";
  inherits: false;
}
@property --tw-inset-shadow-alpha {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 100%;
}
@property --tw-ring-color {
  syntax: "*";
  inherits: false;
}
@property --tw-ring-shadow {
  syntax: "*";
  inherits: false;
  initial-value: 0 0 #0000;
}
@property --tw-inset-ring-color {
  syntax: "*";
  inherits: false;
}
@property --tw-inset-ring-shadow {
  syntax: "*";
  inherits: false;
  initial-value: 0 0 #0000;
}
@property --tw-ring-inset {
  syntax: "*";
  inherits: false;
}
@property --tw-ring-offset-width {
  syntax: "<length>";
  inherits: false;
  initial-value: 0px;
}
@property --tw-ring-offset-color {
  syntax: "*";
  inherits: false;
  initial-value: #fff;
}
@property --tw-ring-offset-shadow {
  syntax: "*";
  inherits: false;
  initial-value: 0 0 #0000;
}
@property --tw-outline-style {
  syntax: "*";
  inherits: false;
  initial-value: solid;
}
@property --tw-blur {
  syntax: "*";
  inherits: false;
}
@property --tw-brightness {
  syntax: "*";
  inherits: false;
}
@property --tw-contrast {
  syntax: "*";
  inherits: false;
}
@property --tw-grayscale {
  syntax: "*";
  inherits: false;
}
@property --tw-hue-rotate {
  syntax: "*";
  inherits: false;
}
@property --tw-invert {
  syntax: "*";
  inherits: false;
}
@property --tw-opacity {
  syntax: "*";
  inherits: false;
}
@property --tw-saturate {
  syntax: "*";
  inherits: false;
}
@property --tw-sepia {
  syntax: "*";
  inherits: false;
}
@property --tw-drop-shadow {
  syntax: "*";
  inherits: false;
}
@property --tw-drop-shadow-color {
  syntax: "*";
  inherits: false;
}
@property --tw-drop-shadow-alpha {
  syntax: "<percentage>";
  inherits: false;
  initial-value: 100%;
}
@property --tw-drop-shadow-size {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-blur {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-brightness {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-contrast {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-grayscale {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-hue-rotate {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-invert {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-opacity {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-saturate {
  syntax: "*";
  inherits: false;
}
@property --tw-backdrop-sepia {
  syntax: "*";
  inherits: false;
}
@property --tw-duration {
  syntax: "*";
  inherits: false;
}
@property --tw-ease {
  syntax: "*";
  inherits: false;
}
@property --tw-content {
  syntax: "*";
  initial-value: "";
  inherits: false;
}
@layer properties {
  @supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color:rgb(from red r g b)))) {
    *, ::before, ::after, ::backdrop {
      --tw-translate-x: 0;
      --tw-translate-y: 0;
      --tw-translate-z: 0;
      --tw-rotate-x: initial;
      --tw-rotate-y: initial;
      --tw-rotate-z: initial;
      --tw-skew-x: initial;
      --tw-skew-y: initial;
      --tw-border-style: solid;
      --tw-leading: initial;
      --tw-font-weight: initial;
      --tw-ordinal: initial;
      --tw-slashed-zero: initial;
      --tw-numeric-figure: initial;
      --tw-numeric-spacing: initial;
      --tw-numeric-fraction: initial;
      --tw-shadow: 0 0 #0000;
      --tw-shadow-color: initial;
      --tw-shadow-alpha: 100%;
      --tw-inset-shadow: 0 0 #0000;
      --tw-inset-shadow-color: initial;
      --tw-inset-shadow-alpha: 100%;
      --tw-ring-color: initial;
      --tw-ring-shadow: 0 0 #0000;
      --tw-inset-ring-color: initial;
      --tw-inset-ring-shadow: 0 0 #0000;
      --tw-ring-inset: initial;
      --tw-ring-offset-width: 0px;
      --tw-ring-offset-color: #fff;
      --tw-ring-offset-shadow: 0 0 #0000;
      --tw-outline-style: solid;
      --tw-blur: initial;
      --tw-brightness: initial;
      --tw-contrast: initial;
      --tw-grayscale: initial;
      --tw-hue-rotate: initial;
      --tw-invert: initial;
      --tw-opacity: initial;
      --tw-saturate: initial;
      --tw-sepia: initial;
      --tw-drop-shadow: initial;
      --tw-drop-shadow-color: initial;
      --tw-drop-shadow-alpha: 100%;
      --tw-drop-shadow-size: initial;
      --tw-backdrop-blur: initial;
      --tw-backdrop-brightness: initial;
      --tw-backdrop-contrast: initial;
      --tw-backdrop-grayscale: initial;
      --tw-backdrop-hue-rotate: initial;
      --tw-backdrop-invert: initial;
      --tw-backdrop-opacity: initial;
      --tw-backdrop-saturate: initial;
      --tw-backdrop-sepia: initial;
      --tw-duration: initial;
      --tw-ease: initial;
      --tw-content: "";
    }
  }
}
`

const tailwindcss = cssr.c([TAILWINDCSS_GENERATED])

export default tailwindcss
