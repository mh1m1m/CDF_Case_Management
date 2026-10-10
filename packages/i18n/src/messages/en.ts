export const en = {
  common: {
    appName: "CDF Case Management & Investigation Platform",
    portalName: "CDF Whistleblowing Portal",
    classificationBanner: "SYNTHETIC DATA · Reference implementation · Not CDF production",
    classificationBannerDetail: "Do not enter real reports, names or documents. All data here is fictional.",
    language: "Language",
    switchToArabic: "العربية",
    switchToEnglish: "English",
    theme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    errorGeneric: "Something went wrong. Reference: {ref}",
    notFound: "Not found or not available to you.",
    back: "Back",
    save: "Save",
    cancel: "Cancel",
    submit: "Submit",
    required: "Required",
  },
};

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Messages = Widen<typeof en>;
