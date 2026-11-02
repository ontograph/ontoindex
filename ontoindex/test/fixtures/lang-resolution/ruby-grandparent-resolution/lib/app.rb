require_relative 'models/c'

def process
  c = C.new
  c.greet.save
end

def process_untyped
  c = C.new
  c.untyped_greet.save
end
