// Fake Clerk Backend API + Stripe on 127.0.0.1:4455 for local previews (src/mock-providers.ts).
//   npm run mock:providers
import { startMockProviders } from "../src/mock-providers.js";

const m = await startMockProviders(Number(process.env.MOCK_PORT ?? 4455));
const { pem } = await (await fetch(`${m.url}/_mock/public-key`)).json();
console.log(`mock Clerk + Stripe on ${m.url}. Point Octillion at it with:
  CLERK_SECRET_KEY=sk_test_mock CLERK_API_URL=${m.url} CLERK_FRONTEND_API_URL=${m.url} STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_URL=${m.url}
  CLERK_JWT_KEY="${pem.replace(/\n/g, "\\n")}"`);
