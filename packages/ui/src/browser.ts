/** The part of NavigatorUAData this needs. It is not in TypeScript's DOM lib. */
export interface BrandedNavigator {
  userAgentData?: { brands: readonly { brand: string }[] };
}

/** Passkeys and PRF are only supported here on Chromium, per the README. */
export function isChromium(nav: BrandedNavigator | undefined): boolean {
  return nav?.userAgentData?.brands.some(({ brand }) => brand === 'Chromium') ?? false;
}
