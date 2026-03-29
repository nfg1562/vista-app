import "../styles/globals.css";
import Layout from "../components/Layout";
import AuthGate from "../components/AuthGate";

function MyApp({ Component, pageProps }) {
  return (
    <Layout>
      <AuthGate>
        <Component {...pageProps} />
      </AuthGate>
    </Layout>
  );
}

export default MyApp;
