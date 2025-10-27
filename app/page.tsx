export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 py-16 text-white">
      <div className="max-w-3xl text-center">
        <p className="text-sm uppercase tracking-[0.3em] text-slate-300">
          Future Home Of
        </p>
        <h1 className="mt-6 text-4xl font-semibold sm:text-5xl">
          Your Custom Sports Picks Platform
        </h1>
        <p className="mt-6 text-lg leading-8 text-slate-300">
          We&apos;re currently building the experience tailored to your brand
          and bettors. When the build is complete, this will be the live home
          for your application.
        </p>
        <div className="mt-12 space-y-3 text-sm text-slate-400">
          <p>✔ Personalized insights and picks</p>
          <p>✔ Mobile-friendly dashboards</p>
          <p>✔ Real-time performance tracking</p>
        </div>
        <p className="mt-12 text-base text-slate-400">
          Have feedback or want a preview? Just reach out and we&apos;ll walk
          through the latest progress together.
        </p>
      </div>
    </main>
  );
}
