import type { ReactNode } from 'react';
export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <header className="page-header"><div><h1 className="title">{title}</h1><p className="page-description">{description}</p></div>{action && <div className="header-action">{action}</div>}</header>;
}
