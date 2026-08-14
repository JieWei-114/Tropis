import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserTable } from '../components/UserTable';

describe('UserTable', () => {
  const user = {
    id: 'user-1',
    name: 'Alice',
    email: 'alice@example.com',
    age: 28,
    status: 'active' as const,
    loginCount: 5,
  };

  it('renders users and shows empty state when no rows exist', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    const { rerender } = render(
      <UserTable users={[]} onEdit={onEdit} onDelete={onDelete} />,
    );

    expect(screen.getByText(/no users found/i)).toBeInTheDocument();

    rerender(<UserTable users={[user]} onEdit={onEdit} onDelete={onDelete} />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    // status renders as a Badge
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('requires delete confirmation before calling onDelete', async () => {
    const ui = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(<UserTable users={[user]} onEdit={onEdit} onDelete={onDelete} />);

    await ui.click(screen.getByRole('button', { name: /delete/i }));
    expect(
      screen.getByRole('button', { name: /confirm/i }),
    ).toBeInTheDocument();

    await ui.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onDelete).toHaveBeenCalledWith(user);
  });
});
