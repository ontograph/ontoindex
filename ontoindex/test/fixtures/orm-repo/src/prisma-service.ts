import { prisma } from './db';

export async function getUsers() {
  return prisma.user.findMany({ where: { active: true } });
}

export async function createPost(title: string, userId: number) {
  return prisma.post.create({ data: { title, authorId: userId } });
}

export async function getUserById(id: number) {
  return prisma.user.findUnique({ where: { id } });
}

export async function updatePost(id: number, title: string) {
  return prisma.post.update({ where: { id }, data: { title } });
}

export async function deletePost(id: number) {
  return prisma.post.delete({ where: { id } });
}

export async function countUsers() {
  return prisma.user.count();
}
