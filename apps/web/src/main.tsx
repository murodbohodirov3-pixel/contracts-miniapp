import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return <main className="shell"><section className="card"><p className="eyebrow">Contracts Mini App</p><h1>Учет договоров и оплат</h1><p>Локальный стек подготовлен. Вход и рабочие данные будут подключены после применения миграций.</p><a href="/health/live">Проверить API</a></section></main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
