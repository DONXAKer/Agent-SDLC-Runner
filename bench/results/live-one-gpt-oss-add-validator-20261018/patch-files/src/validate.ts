/**
 * Validate customer data.
 * Returns array of violation codes. Order: 'email', then 'phone'.
 */

export function validateCustomer(customer: { email: string; phone: string }): string[] {
  const violations: string[] = [];

  // Email validation
  const { email, phone } = customer;
  let emailValid = true;
  if (typeof email !== 'string') {
    emailValid = false;
  } else {
    // No spaces
    if (email.includes(' ')) {
      emailValid = false;
    }
    const atParts = email.split('@');
    if (atParts.length !== 2) {
      emailValid = false;
    } else {
      const [local, domain] = atParts;
      if (!local) {
        emailValid = false;
      } else {
        // Domain must contain dot and not start or end with dot
        if (domain.indexOf('.') === -1 || domain.startsWith('.') || domain.endsWith('.')) {
          emailValid = false;
        }
      }
    }
  }
  if (!emailValid) violations.push('email');

  // Phone validation
  let phoneValid = true;
  if (typeof phone !== 'string') {
    phoneValid = false;
  } else {
    const regex = /^\+7\d{10}$|^8\d{10}$/;
    if (!regex.test(phone)) {
      phoneValid = false;
    }
  }
  if (!phoneValid) violations.push('phone');

  return violations;
}
