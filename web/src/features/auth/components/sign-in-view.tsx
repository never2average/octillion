import { SignIn } from '@clerk/nextjs';
import { AuthPanel } from './auth-panel';

export default function SignInViewPage() {
  return (
    <div className='relative flex min-h-screen flex-col items-center justify-center overflow-hidden md:grid lg:max-w-none lg:grid-cols-2 lg:px-0'>
      <AuthPanel />
      <div className='flex h-full items-center justify-center p-4 lg:p-8'>
        <SignIn fallbackRedirectUrl='/app' signUpUrl='/auth/sign-up' />
      </div>
    </div>
  );
}
