import SignInForm from "./form";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }) {
  const params = await searchParams;

  return (
    <>
      <h1>Sign in</h1>
      <p className="lede">
        No password. Give us an email address and we will send you a link.
      </p>

      {params?.error ? <p className="notice err">{params.error}</p> : null}

      <SignInForm />

      <p className="muted">
        The link works once and expires in 15 minutes. If you have not signed up
        before, using it creates your account.
      </p>
    </>
  );
}
