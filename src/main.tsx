import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider, useRoute } from './app';
import { Layout } from './components';
import { createRepo } from './data';
import { AdminEvent, AdminHome } from './pages/admin';
import { Dashboard, EventPage, Rules, Schedule } from './pages/public';
import './styles.css';

function Routes() {
  const route = useRoute();
  const [a, b, c] = route;
  let page;
  if (!a) page = <Dashboard />;
  else if (a === 'schedule') page = <Schedule />;
  else if (a === 'rules') page = <Rules />;
  else if (a === 'events' && b) page = <EventPage n={Number(b)} />;
  else if (a === 'admin' && b === 'events' && c) page = <AdminEvent n={Number(c)} />;
  else if (a === 'admin') page = <AdminHome />;
  else page = <p>Page not found. <a href="#/">Go home</a></p>;
  return <Layout route={route}>{page}</Layout>;
}

createRepo().then((repo) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppProvider repo={repo}>
        <Routes />
      </AppProvider>
    </StrictMode>,
  );
});
