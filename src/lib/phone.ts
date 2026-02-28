export type SplitPhone = {
  phoneE164: string;
  countryCode: string;
  nationalNumber: string;
  whatsappLink: string;
};

export function normalizePhoneE164(input: string): string | null {
  if (!input) return null;
  let s = input.trim().replace(/[\s\-()]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;

  if (s.startsWith("+")) {
    const digits = s.slice(1).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return null;
    return `+${digits}`;
  }

  const d = s.replace(/\D/g, "");
  if (/^92\d{10}$/.test(d)) return `+${d}`;
  if (/^03\d{9}$/.test(d)) return `+92${d.slice(1)}`;
  if (/^3\d{9}$/.test(d)) return `+92${d}`;
  if (/^[1-9]\d{9,14}$/.test(d)) return `+${d}`;
  return null;
}

export function splitE164(phoneE164: string): SplitPhone {
  const digits = phoneE164.replace(/^\+/, "");
  for (let len = 3; len >= 1; len--) {
    const cc = digits.slice(0, len);
    if (!cc) continue;
    const national = digits.slice(len);
    return {
      phoneE164,
      countryCode: `+${cc}`,
      nationalNumber: national,
      whatsappLink: `https://wa.me/${digits}`
    };
  }

  return {
    phoneE164,
    countryCode: "",
    nationalNumber: digits,
    whatsappLink: ""
  };
}
