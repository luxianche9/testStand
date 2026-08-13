import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function make(children: ReactNode) {
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
      >
        {children}
      </svg>
    );
  };
}

export const IconChip = make(<>
  <rect x="5" y="5" width="14" height="14" rx="2" />
  <rect x="9.5" y="9.5" width="5" height="5" />
  <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
</>);

export const IconServer = make(<>
  <rect x="2" y="3" width="20" height="7" rx="2" />
  <rect x="2" y="14" width="20" height="7" rx="2" />
  <path d="M6 6.5h.01M6 17.5h.01" />
</>);

export const IconDesktop = make(<>
  <rect x="2" y="3" width="20" height="14" rx="2" />
  <path d="M8 21h8M12 17v4" />
</>);

export const IconFolder = make(<>
  <path d="M3 7a2 2 0 012-2h4l2 2.5h8a2 2 0 012 2V17a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
</>);

/** 工程：一份带接线/编排的工程文档。 */
export const IconProject = make(<>
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
  <path d="M14 2v6h6" />
  <path d="M8.5 15.5 10 17l1.5-1.5M10 17v-3.5" />
  <circle cx="15.5" cy="13.5" r="1.6" />
  <path d="M15.5 15.1v2.4M13.9 17.5h3.2" />
</>);

/** 接线/连接：两个端口节点相连。 */
export const IconWiring = make(<>
  <circle cx="5.5" cy="12" r="2.5" />
  <circle cx="18.5" cy="12" r="2.5" />
  <path d="M8 12h8" />
</>);

/** 延时：时钟。 */
export const IconClock = make(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M12 7v5l3.5 2" />
</>);

/** 变量赋值：x = 1。 */
export const IconVariable = make(<>
  <path d="M4 7l5 5M9 7l-5 5" />
  <path d="M13 16h7M13 20h7" />
</>);

/** 断言：对勾盾牌。 */
export const IconAssert = make(<>
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  <path d="M8.5 11.5 11 14l4.5-4.5" />
</>);

export function IconMcp({ size = 16, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  );
}

export const IconRefresh = make(<>
  <path d="M23 4v6h-6M1 20v-6h6" />
  <path d="M3.5 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.5 15" />
</>);

export const IconPlus = make(<path d="M12 5v14M5 12h14" />);

export const IconSun = make(<>
  <circle cx="12" cy="12" r="4.5" />
  <path d="M12 1.5v2M12 20.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M1.5 12h2M20.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
</>);

export const IconMoon = make(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />);

export const IconSystem = make(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
</>);

export const IconChevron = make(<path d="M9 6l6 6-6 6" />);

export const IconPlay = make(<path d="M7 4.5 19 12 7 19.5z" />);

export const IconStop = make(<rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />);

export const IconLog = make(<>
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
  <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
</>);

export const IconEdit = make(<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />);

export const IconTrash = make(<>
  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
</>);

export const IconCopy = make(<>
  <rect x="9" y="9" width="13" height="13" rx="2" />
  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
</>);

export const IconClose = make(<path d="M18 6 6 18M6 6l12 12" />);

export const IconEye = make(<>
  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
  <circle cx="12" cy="12" r="3" />
</>);

export const IconEyeOff = make(<>
  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
  <path d="M1 1l22 22" />
</>);

export const IconAlert = make(<>
  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
  <path d="M12 9v4M12 17h.01" />
</>);

export const IconImage = make(<>
  <rect x="3" y="3" width="18" height="18" rx="2" />
  <circle cx="8.5" cy="8.5" r="1.5" />
  <path d="m21 15-5-5L5 21" />
</>);

export const IconDownload = make(<>
  <path d="M12 3v12M7 11l5 5 5-5" />
  <path d="M3 20h18" />
</>);

/** 窗口最小化。 */
export const IconMinus = make(<path d="M5 12h14" />);

/** 窗口最大化。 */
export const IconMaximize = make(<rect x="5" y="5" width="14" height="14" rx="1" />);

/** 窗口还原（双矩形）。 */
export const IconRestore = make(<>
  <rect x="8" y="8" width="12" height="12" rx="1" />
  <path d="M4 16V5a1 1 0 0 1 1-1h11" />
</>);
