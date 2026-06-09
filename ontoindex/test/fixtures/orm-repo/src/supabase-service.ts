import { supabase } from './client';

export async function getBookings() {
  return supabase.from('bookings').select('*');
}

export async function createInterpreter(name: string) {
  return supabase.from('interpreters').insert({ name, active: true });
}

export async function updateBooking(id: string, status: string) {
  return supabase.from('bookings').update({ status }).eq('id', id);
}

export async function deleteSession(id: string) {
  return supabase.from('sessions').delete().eq('id', id);
}
